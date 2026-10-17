import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse, badRequest, notFound, conflict } from '../../utils/http.js';
import { env } from '../../config/env.js';
import { MapTracking, MapScan, GoogleAccount } from '../../models/index.js';
import { isLiveConnection } from '../reviews/policy.js';
import { generateGrid, metrics, signature, competitorMetrics, compareScans, regions, recommendations, scanReport } from './metrics.js';
import { runMapScans } from './runner.js';
import { geocodeLocation, trackingLocation } from './geocoding.js';

const centerSchema = z.object({ latitude: z.number().min(-80).max(80), longitude: z.number().min(-180).max(180) });
export const settingsSchema = z.object({
  placeId: z.string().trim().min(10).max(200).regex(/^[\w-]+$/, 'Enter a Google Place ID, not a URL or business name'),
  center: centerSchema,
  keywords: z.array(z.string().trim().min(2).max(120)).min(1).max(20).transform(a => [...new Set(a)]),
  language: z.enum(['en', 'hi', 'es', 'fr', 'de', 'pt', 'it', 'ar']).default('en'),
  coordinateSource: z.enum(['owner', 'google']).default('owner'),
  confirmed: z.literal(true, { errorMap: () => ({ message: 'Confirm the actual business Place ID and coordinates' }) }),
});
export const scanSchema = z.object({
  keyword: z.string().trim().min(2).max(120), radiusKm: z.number().min(0.1).max(25),
  gridSize: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(9)]),
  rankingRange: z.union([z.literal(3), z.literal(10), z.literal(20)]),
  approved: z.literal(true, { errorMap: () => ({ message: 'Approve the provider requests for this scan' }) }),
});
const idSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid scan ID');
const availableScans = () => ({ $or: [{ geoDataExpiresAt: { $exists: false } }, { geoDataExpiresAt: null }, { geoDataExpiresAt: { $gt: new Date() } }] });
const metadata = scan => {
  const { points, leaseUntil, ...rest } = scan;
  return { ...rest, summary: metrics(points, scan.rankingRange) };
};
const owned = async (req, id) => {
  const scan = await MapScan.findOne({ _id: parse(idSchema, id), business: req.business._id, ...availableScans() }).lean();
  if (!scan) throw notFound('Scan');
  return scan;
};

export const mapVisibilityRouter = Router();
mapVisibilityRouter.use(requireAuth, requireBusiness);
mapVisibilityRouter.use(rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));
mapVisibilityRouter.get('/', ah(async (req, res) => {
  const settings = await MapTracking.findOne({ business: req.business._id }).lean();
  const location = await trackingLocation(settings);
  const account = await GoogleAccount.findOne({ business: req.business._id }).lean();
  const suggestedCenter = req.business.locationSettings?.confirmedAt ? req.business.locationSettings.pin : isLiveConnection(account) ? account.remote?.latlng : null;
  const active = await MapScan.findOne({ business: req.business._id, active: true, ...availableScans() }).select('-points.results').lean();
  const recent = (await Promise.all((settings?.keywords || []).map(keyword => MapScan.findOne({ business: req.business._id, keyword, ...availableScans(), status: { $in: ['complete', 'partial', 'failed', 'cancelled'] } }).sort({ createdAt: -1 }).select('-points.results').lean()))).filter(Boolean);
  const latest = await Promise.all(recent.map(async scan => {
    const previous = await MapScan.findOne({ business: req.business._id, signature: scan.signature, ...availableScans(), status: 'complete', createdAt: { $lt: scan.createdAt } }).sort({ createdAt: -1 }).select('-points.results').lean();
    const comparison = compareScans(scan, previous);
    return { ...metadata(scan), visibilityChange: comparison.comparable ? comparison.visibilityChange : null };
  }));
  res.json({ provider: { name: 'SerpApi', configured: !!env.mapVisibility.apiKey, maxDepth: 20 }, geocodingConfigured: !!env.mapVisibility.geocodingKey, settings: settings ? { ...settings, center: location?.center, coordinateExpiresAt: location?.expiresAt } : null, suggestedCenter, active: active ? metadata(active) : null, latest });
}));
mapVisibilityRouter.put('/settings', ah(async (req, res) => {
  const { confirmed, ...body } = parse(settingsSchema, req.body);
  let location;
  if (body.coordinateSource === 'google') {
    const cache = await geocodeLocation(req.business._id, { placeId: body.placeId });
    const result = cache.results.find(r => r.placeId === body.placeId);
    if (!result) throw badRequest('Google did not return this business Place ID.');
    location = { latitude: result.latitude, longitude: result.longitude };
    delete body.center;
  }
  const settings = await MapTracking.findOneAndUpdate({ business: req.business._id }, { $set: body, ...(location ? { $unset: { center: 1 } } : {}) }, { upsert: true, new: true, runValidators: true });
  res.json({ settings: { ...settings.toObject(), ...(location ? { center: location } : {}) } });
}));
mapVisibilityRouter.post('/geocode', rateLimit({ windowMs: 3600000, limit: 20, keyGenerator: req => String(req.business._id), standardHeaders: 'draft-7', legacyHeaders: false }), ah(async (req, res) => {
  const query = parse(z.object({ address: z.string().trim().min(5).max(600).optional(), placeId: z.string().regex(/^[\w-]{10,200}$/).optional() }).refine(v => !!v.address !== !!v.placeId, 'Enter an address or a Place ID'), req.body);
  const cache = await geocodeLocation(req.business._id, query);
  res.json({ results: cache.results, expiresAt: cache.expiresAt, attribution: 'Google Maps' });
}));
mapVisibilityRouter.get('/preview', ah(async (req, res) => {
  const { radiusKm, gridSize } = parse(z.object({ radiusKm: z.coerce.number().min(0.1).max(25), gridSize: z.coerce.number().refine(n => [3, 5, 7, 9].includes(n)) }), req.query);
  const settings = await MapTracking.findOne({ business: req.business._id }).lean();
  const account = await GoogleAccount.findOne({ business: req.business._id }).lean();
  const location = await trackingLocation(settings);
  const center = settings ? location?.center : req.business.locationSettings?.confirmedAt ? req.business.locationSettings.pin : isLiveConnection(account) ? account.remote?.latlng : null;
  if (!center || !Number.isFinite(center.latitude) || !Number.isFinite(center.longitude)) return res.json({ points: [], center: null });
  res.json({ center, points: generateGrid(center, radiusKm, gridSize) });
}));
mapVisibilityRouter.get('/scans', ah(async (req, res) => {
  const { offset, keyword } = parse(z.object({ offset: z.coerce.number().int().min(0).max(10000).default(0), keyword: z.string().max(120).optional() }), req.query);
  const query = { business: req.business._id, ...availableScans(), ...(keyword ? { keyword } : {}) };
  const scans = await MapScan.find(query).sort({ createdAt: -1 }).skip(offset).limit(51).select('-points.results').lean();
  res.json({ scans: scans.slice(0, 50).map(metadata), nextOffset: scans.length > 50 ? offset + 50 : null });
}));
mapVisibilityRouter.post('/scans', rateLimit({ windowMs: 3600000, limit: 6, keyGenerator: req => String(req.business._id), standardHeaders: 'draft-7', legacyHeaders: false }), ah(async (req, res) => {
  const body = parse(scanSchema, req.body);
  if (!env.mapVisibility.apiKey) throw badRequest('Set SERPAPI_API_KEY on the backend before running a real map scan.');
  const settings = await MapTracking.findOne({ business: req.business._id }).lean();
  if (!settings || !settings.keywords.includes(body.keyword)) throw badRequest('Save an actual location, Place ID and tracked keyword first.');
  const location = await trackingLocation(settings);
  if (!location?.center) throw badRequest('Refresh the Google location or save independent business coordinates before scanning.');
  const configuration = { keyword: body.keyword, radiusKm: body.radiusKm, gridSize: body.gridSize, rankingRange: body.rankingRange, language: settings.language, center: location.center, placeId: settings.placeId, provider: 'serpapi', geoDataExpiresAt: location.expiresAt || undefined };
  await MapScan.init();
  let scan;
  try { scan = await MapScan.create({ ...configuration, business: req.business._id, businessName: req.business.name, signature: signature(configuration), points: generateGrid(location.center, body.radiusKm, body.gridSize) }); } catch (err) {
    if (err.code === 11000) throw conflict('A scan is already queued or running for this business.');
    throw err;
  }
  res.status(202).json({ scan: metadata(scan.toObject()) });
  void runMapScans();
}));
mapVisibilityRouter.get('/scans/:id/report', ah(async (req, res) => {
  const scan = await owned(req, req.params.id);
  const baseline = req.query.baseline ? await owned(req, req.query.baseline) : null;
  res.type('text/plain').set('Content-Disposition', 'attachment; filename="reviewrankr-map-visibility.txt"').send(scanReport(scan, baseline));
}));
mapVisibilityRouter.get('/scans/:id', ah(async (req, res) => {
  const scan = await owned(req, req.params.id);
  const query = parse(z.object({ baseline: idSchema.optional(), compareDays: z.enum(['1', '7', '30']).optional(), compare: z.literal('none').optional() }), req.query);
  const cutoff = query.compareDays ? new Date(new Date(scan.createdAt).getTime() - Number(query.compareDays) * 86400000) : scan.createdAt;
  const baseline = query.compare === 'none' ? null : query.baseline ? await owned(req, query.baseline) : await MapScan.findOne({ business: req.business._id, signature: scan.signature, ...availableScans(), status: 'complete', createdAt: { $lt: cutoff } }).sort({ createdAt: -1 }).lean();
  res.json({ scan: { ...scan, summary: metrics(scan.points, scan.rankingRange) }, competitors: competitorMetrics(scan), regions: regions(scan), recommendations: recommendations(scan), baseline: baseline ? metadata(baseline) : null, comparison: compareScans(scan, baseline) });
}));
mapVisibilityRouter.post('/scans/:id/cancel', ah(async (req, res) => {
  await owned(req, req.params.id);
  const scan = await MapScan.findOneAndUpdate({ _id: req.params.id, business: req.business._id, active: true }, { $set: { active: false, status: 'cancelled', completedAt: new Date(), error: 'Cancelled by the business. Unchecked points remain unknown; an in-flight request may still be charged.' } }, { new: true });
  if (!scan) throw conflict('This scan is no longer running.');
  res.json({ scan: metadata(scan.toObject()) });
}));
