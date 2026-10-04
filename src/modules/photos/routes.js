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
  const photos = await Photo.insertMany(
    req.files.map((f) => ({
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
  res.status(201).json({ photos });
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
