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
import { imageSize } from 'image-size';
import { mediaAudit, approvedMedia, supportedPhoto } from './audit.js';
import { isLiveConnection } from '../reviews/policy.js';
import * as google from '../google/client.js';
import { loadAccount } from '../google/sync.js';

export const photosRouter = Router();
photosRouter.use(requireAuth, requireBusiness);

const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4' };

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
  limits: { fileSize: 50 * 1024 * 1024, files: 12 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED[file.mimetype]) return cb(badRequest('Upload JPG, PNG, WebP or MP4 files'));
    cb(null, true);
  },
});

photosRouter.get('/', ah(async (req, res) => {
  const filter = { business: req.business._id };
  if (req.query.category && PHOTO_CATEGORIES.includes(String(req.query.category))) filter.category = req.query.category;
  const photos = await Photo.find(filter).sort({ createdAt: -1 });
  res.json({ photos, categories: PHOTO_CATEGORIES });
}));

photosRouter.get('/audit', ah(async (req, res) => {
  const [media, services] = await Promise.all([Photo.find({ business: req.business._id }).lean(), Service.find({ business: req.business._id, active: true }).lean()]);
  res.json(mediaAudit(media, services));
}));

photosRouter.post('/activity/refresh', ah(async (req, res) => {
  const account = await loadAccount(req.business._id);
  if (!isLiveConnection(account)) throw badRequest('Connect a live Google Business Profile first');
  const result = await google.listAllMedia(account);
  let updated = 0;
  for (const item of result) {
    if (item.insights?.viewCount == null) continue;
    const change = await Photo.updateOne({ business: req.business._id, 'google.mediaName': item.name }, { 'google.viewCount': item.insights.viewCount, 'google.insightsAt': new Date() });
    updated += change.matchedCount;
  }
  res.json({ updated });
}));

photosRouter.post('/', upload.array('files', 12), ah(async (req, res) => {
  const category = PHOTO_CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
  if (!req.files?.length) throw badRequest('Choose at least one photo or video');
  const records = [];
  let photos;
  try {
    for (const file of req.files) {
      const buffer = await fs.promises.readFile(file.path);
      const video = file.mimetype === 'video/mp4';
      if (video && buffer.toString('ascii', 4, 8) !== 'ftyp') throw badRequest('The video is not a supported MP4 file');
      if (!video && file.size > 8 * 1024 * 1024) throw badRequest('Photos must be smaller than 8 MB');
      let dimensions = {};
      if (!video) {
        try { dimensions = imageSize(buffer); } catch { throw badRequest('The image could not be read'); }
        if (dimensions.type !== { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.mimetype]) throw badRequest('The image contents do not match its file type');
      }
      records.push({ business: req.business._id, category, fileUrl: `/uploads/${req.business._id}/${file.filename}`, fileName: file.originalname, mimeType: file.mimetype, size: file.size, caption: String(req.body.caption || '').slice(0, 300), mediaType: video ? 'video' : 'photo', width: dimensions.width, height: dimensions.height, queued: false, approval: { status: 'pending' } });
    }
    photos = await Photo.insertMany(records);
  } catch (err) { await Promise.all(req.files.map((f) => fs.promises.unlink(f.path).catch(() => {}))); throw err; }
  const autoQueue = false;
  if (autoQueue) await planPhotos(req.business);
  res.status(201).json({ photos, queued: autoQueue });
}));

/** The weekly photo schedule: queue with planned times, and what was posted. */
photosRouter.get('/schedule', ah(async (req, res) => {
  await planPhotos(req.business);
  const tz = safeTz(req.business.timezone);
  const [queue, posted, failed, account, thisWeek] = await Promise.all([
    Photo.find({ business: req.business._id, queued: true }).sort({ queuePosition: 1, createdAt: 1 }).lean(),
    Photo.find({ business: req.business._id, postedAt: { $exists: true }, 'google.syncStatus': 'synced' }).sort({ postedAt: -1 }).limit(24).lean(),
    Photo.find({ business: req.business._id, queued: false, 'google.syncStatus': 'failed' }).sort({ updatedAt: -1 }).limit(12).lean(),
    GoogleAccount.findOne({ business: req.business._id }).select('mode status locationName').lean(),
    postedInWeek(req.business._id, weekStartYmd(new Date(), tz), tz),
  ]);
  const library = await Photo.countDocuments({ business: req.business._id });
  res.json({
    queue, posted, failed, library,
    postedThisWeek: thisWeek,
    settings: req.business.autopilot?.photos,
    connection: isLiveConnection(account) ? 'live' : null,
  });
}));

/** Add to / remove from the weekly queue */
photosRouter.post('/:id/queue', ah(async (req, res) => {
  const body = parse(z.object({ queued: z.boolean() }), req.body);
  const photo = await Photo.findOne({ _id: req.params.id, business: req.business._id });
  if (!photo) throw notFound('Photo');
  if (body.queued && !canQueue(photo)) throw badRequest('Logo and cover photos are set once, not posted weekly');
  if (body.queued && (!approvedMedia(photo) || !supportedPhoto(photo))) throw badRequest('Approve a photo before adding it to the publishing queue');
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
  const body = parse(z.object({ caption: z.string().max(300).optional(), category: z.enum(PHOTO_CATEGORIES).optional(), services: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).max(30).optional(), capturedAt: z.string().datetime().nullable().optional() }), req.body);
  if (body.services && await Service.countDocuments({ business: req.business._id, _id: { $in: body.services } }) !== new Set(body.services).size) throw badRequest('Choose services from your own business');
  const photo = await Photo.findOneAndUpdate({ _id: req.params.id, business: req.business._id }, body, { new: true });
  if (!photo) throw notFound('Photo');
  res.json({ photo });
}));

photosRouter.post('/:id/approval', ah(async (req, res) => {
  const body = parse(z.object({ status: z.enum(['approved', 'rejected']) }), req.body);
  const photo = await Photo.findOne({ _id: req.params.id, business: req.business._id });
  if (!photo) throw notFound('Media');
  photo.approval = { status: body.status, approvedBy: req.user._id, approvedAt: new Date() };
  if (body.status === 'rejected') { photo.queued = false; photo.scheduledFor = undefined; }
  else if (canQueue(photo) && !photo.postedAt && req.business.autopilot?.photos?.autoQueueUploads !== false) { photo.queued = true; photo.queuePosition = await nextQueuePosition(req.business._id); }
  if (body.status === 'approved' && photo.category === 'logo' && supportedPhoto(photo)) { req.business.logoUrl = photo.fileUrl; await req.business.save(); }
  await photo.save();
  await planPhotos(req.business);
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
