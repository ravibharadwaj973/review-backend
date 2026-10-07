import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse, notFound, badRequest } from '../../utils/http.js';
import { Photo, PHOTO_CATEGORIES, Service } from '../../models/index.js';
import { env } from '../../config/env.js';
import { randomToken } from '../../utils/crypto.js';
import { generateContent } from '../ai/service.js';
import { canQueue, nextQueuePosition, planPhotos, postPhotoNow, postedInWeek } from './schedule.js';
import { GoogleAccount } from '../../models/index.js';
import { safeTz, weekStartYmd } from '../../utils/time.js';

export const photosRouter = Router();
photosRouter.use(requireAuth, requireBusiness);

const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const dir = path.resolve(env.uploadDir, String(req.business._id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    cb(null, `${Date.now()}-${randomToken(6)}${ALLOWED[file.mimetype] || ''}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024, files: 12 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED[file.mimetype]) return cb(badRequest('Upload JPG, PNG or WebP images'));
    cb(null, true);
  },
});

photosRouter.get('/', ah(async (req, res) => {
  const filter = { business: req.business._id };
  if (req.query.category && PHOTO_CATEGORIES.includes(String(req.query.category))) filter.category = req.query.category;
  const photos = await Photo.find(filter).sort({ createdAt: -1 });
  res.json({ photos, categories: PHOTO_CATEGORIES });
}));

photosRouter.post('/', upload.array('files', 12), ah(async (req, res) => {
  const category = PHOTO_CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
  if (!req.files?.length) throw badRequest('Choose at least one image');
  const autoQueue = req.business.autopilot?.photos?.autoQueueUploads !== false && !['logo', 'cover'].includes(category) && req.body.queue !== 'false';
  let position = autoQueue ? await nextQueuePosition(req.business._id) : 0;
  const photos = await Photo.insertMany(
    req.files.map((f) => ({
      queued: autoQueue,
      queuePosition: autoQueue ? position++ : 0,
      business: req.business._id,
      category,
      fileUrl: `/uploads/${req.business._id}/${f.filename}`,
      fileName: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
      caption: req.body.caption || '',
    }))
  );
  if (category === 'logo' && photos[0]) {
    req.business.logoUrl = photos[0].fileUrl;
    await req.business.save();
  }
  if (autoQueue) await planPhotos(req.business);
  res.status(201).json({ photos, queued: autoQueue });
}));

/** The weekly photo schedule: queue with planned times, and what was posted. */
photosRouter.get('/schedule', ah(async (req, res) => {
  await planPhotos(req.business);
  const tz = safeTz(req.business.timezone);
  const [queue, posted, failed, account, thisWeek] = await Promise.all([
    Photo.find({ business: req.business._id, queued: true }).sort({ queuePosition: 1, createdAt: 1 }).lean(),
    Photo.find({ business: req.business._id, postedAt: { $exists: true } }).sort({ postedAt: -1 }).limit(24).lean(),
    Photo.find({ business: req.business._id, queued: false, 'google.syncStatus': 'failed' }).sort({ updatedAt: -1 }).limit(12).lean(),
    GoogleAccount.findOne({ business: req.business._id }).select('mode locationName').lean(),
    postedInWeek(req.business._id, weekStartYmd(new Date(), tz), tz),
  ]);
  const library = await Photo.countDocuments({ business: req.business._id });
  res.json({
    queue, posted, failed, library,
    postedThisWeek: thisWeek,
    settings: req.business.autopilot?.photos,
    connection: account ? account.mode : null,
  });
}));

/** Add to / remove from the weekly queue */
photosRouter.post('/:id/queue', ah(async (req, res) => {
  const body = parse(z.object({ queued: z.boolean() }), req.body);
  const photo = await Photo.findOne({ _id: req.params.id, business: req.business._id });
  if (!photo) throw notFound('Photo');
  if (body.queued && !canQueue(photo)) throw badRequest('Logo and cover photos are set once, not posted weekly');
  photo.queued = body.queued;
  if (body.queued) {
    photo.queuePosition = await nextQueuePosition(req.business._id);
    if (photo.google?.syncStatus === 'failed') photo.google = { syncStatus: 'not_synced' };
  } else {
    photo.scheduledFor = undefined;
  }
  await photo.save();
  await planPhotos(req.business);
  res.json({ photo });
}));

/** New queue order: ids in the order they should be posted */
photosRouter.post('/queue/order', ah(async (req, res) => {
  const body = parse(z.object({ ids: z.array(z.string()).min(1).max(500) }), req.body);
  for (let i = 0; i < body.ids.length; i += 1) {
    await Photo.updateOne({ _id: body.ids[i], business: req.business._id, queued: true }, { queuePosition: i + 1 });
  }
  await planPhotos(req.business);
  res.json({ ok: true });
}));

photosRouter.post('/:id/post-now', ah(async (req, res) => {
  const photo = await Photo.findOne({ _id: req.params.id, business: req.business._id });
  if (!photo) throw notFound('Photo');
  await postPhotoNow(req.business, photo);
  await planPhotos(req.business);
  if (photo.google?.syncStatus === 'failed') throw badRequest(`Google didn’t accept the photo: ${photo.google.error}`);
  res.json({ photo });
}));

photosRouter.patch('/:id', ah(async (req, res) => {
  const body = parse(z.object({ caption: z.string().max(300).optional(), category: z.enum(PHOTO_CATEGORIES).optional() }), req.body);
  const photo = await Photo.findOneAndUpdate({ _id: req.params.id, business: req.business._id }, body, { new: true });
  if (!photo) throw notFound('Photo');
  res.json({ photo });
}));

photosRouter.post('/:id/caption', ah(async (req, res) => {
  const photo = await Photo.findOne({ _id: req.params.id, business: req.business._id });
  if (!photo) throw notFound('Photo');
  const services = await Service.find({ business: req.business._id, active: true }).lean();
  const { text, model } = await generateContent({ kind: 'caption', business: req.business, services, target: photo });
  res.json({ caption: text, model });
}));

photosRouter.delete('/:id', ah(async (req, res) => {
  const photo = await Photo.findOneAndDelete({ _id: req.params.id, business: req.business._id });
  if (!photo) throw notFound('Photo');
  const file = path.resolve(env.uploadDir, photo.fileUrl.replace(/^\/uploads\//, ''));
  fs.promises.unlink(file).catch(() => {});
  res.json({ ok: true });
}));
