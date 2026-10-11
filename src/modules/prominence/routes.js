import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse, notFound, badRequest } from '../../utils/http.js';
import { ExternalSource } from '../../models/index.js';
import { publicUrl } from '../website/network.js';
import { checkExternalSource } from './service.js';

export const prominenceRouter = Router();
prominenceRouter.use(requireAuth, requireBusiness);
const sourceSchema = z.object({ url: z.string().url().max(1000), kind: z.enum(['directory', 'press', 'industry', 'community', 'other']).default('other') });
prominenceRouter.get('/', ah(async (req, res) => {
  await ExternalSource.updateMany({ business: req.business._id, status: 'checking', checkStartedAt: { $lt: new Date(Date.now() - 5 * 60000) } }, { status: 'failed', error: 'The source check did not finish. Try again.' });
  const sources = await ExternalSource.find({ business: req.business._id }).sort({ updatedAt: -1 }).limit(100).lean();
  res.json({ sources, coverage: 'Supplied sources only. This is not a complete backlink or web-mention index.', providerConnected: false });
}));
prominenceRouter.post('/', ah(async (req, res) => {
  const body = parse(sourceSchema, req.body);
  if (await ExternalSource.countDocuments({ business: req.business._id }) >= 100) throw badRequest('Keep this source list within 100 URLs');
  const source = await ExternalSource.create({ ...body, url: publicUrl(body.url).href, business: req.business._id });
  res.status(201).json({ source });
}));
prominenceRouter.post('/import', ah(async (req, res) => {
  const body = parse(z.object({ provider: z.string().trim().min(2).max(80), sources: z.array(sourceSchema.extend({ observedAt: z.string().datetime({ offset: true }).optional(), targetUrl: z.union([z.literal(''), z.string().url().max(1000)]).transform((v) => v || undefined).optional(), businessName: z.string().max(160).optional(), phone: z.string().max(50).optional(), address: z.string().max(300).optional() })).min(1).max(50) }), req.body);
  const existing = await ExternalSource.find({ business: req.business._id }).select('url').lean();
  const allUrls = new Set(existing.map((s) => s.url));
  body.sources.forEach((s) => allUrls.add(publicUrl(s.url).href));
  if (allUrls.size > 100) throw badRequest('The imported list would exceed 100 source URLs');
  for (const source of body.sources) {
    const { url, kind, ...providerReported } = source;
    await ExternalSource.updateOne({ business: req.business._id, url: publicUrl(url).href }, { $set: { kind, provider: body.provider, providerReported }, $setOnInsert: { business: req.business._id, url: publicUrl(url).href, status: 'unchecked' } }, { upsert: true, runValidators: true });
  }
  res.json({ imported: body.sources.length });
}));
prominenceRouter.post('/:id/check', rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }), ah(async (req, res) => {
  const source = await ExternalSource.findOneAndUpdate({ _id: req.params.id, business: req.business._id, status: { $ne: 'checking' } }, { status: 'checking', checkStartedAt: new Date() }, { new: true });
  if (!source) throw badRequest('This source is unavailable or already being checked');
  try {
    const evidence = await checkExternalSource(source.url, req.business);
    source.previousEvidence = source.evidence || null;
    source.evidence = evidence;
    source.checkedAt = new Date();
    source.status = 'checked';
    source.error = undefined;
  } catch (err) { source.status = 'failed'; source.error = err.message; }
  await source.save();
  res.json({ source });
}));
prominenceRouter.delete('/:id', ah(async (req, res) => {
  const result = await ExternalSource.deleteOne({ _id: req.params.id, business: req.business._id });
  if (!result.deletedCount) throw notFound('External source');
  res.json({ ok: true });
}));
