import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse, HttpError } from '../../utils/http.js';
import { Service, GoogleAccount } from '../../models/index.js';
import { WebsiteAudit } from '../../models/WebsiteAudit.js';
import { publicUrl } from './network.js';
import { crawlWebsite } from './audit.js';

export const websiteRouter = Router();
websiteRouter.use(requireAuth, requireBusiness);
websiteRouter.get('/', ah(async (req, res) => {
  await WebsiteAudit.updateOne({ business: req.business._id, status: 'running', startedAt: { $lt: new Date(Date.now() - 10 * 60000) } }, { status: 'failed', error: 'The previous audit did not finish. Run the audit again.' });
  const audit = await WebsiteAudit.findOne({ business: req.business._id }).lean();
  res.json({ audit, website: req.business.links?.website || '' });
}));
websiteRouter.post('/', rateLimit({ windowMs: 15 * 60000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false }), ah(async (req, res) => {
  const body = parse(z.object({ url: z.string().url().max(1000) }), req.body);
  const url = publicUrl(body.url).href;
  const previous = await WebsiteAudit.findOne({ business: req.business._id }).lean();
  let audit;
  try {
    audit = await WebsiteAudit.findOneAndUpdate({ business: req.business._id, $or: [{ status: { $ne: 'running' } }, { startedAt: { $lt: new Date(Date.now() - 10 * 60000) } }] }, { $set: { url, status: 'running', startedAt: new Date(), previousSummary: previous?.report && previous.url === url ? { ...previous.report.summary, completedAt: previous.report.completedAt } : null }, $unset: { error: 1 } }, { upsert: true, new: true, runValidators: true });
  } catch (err) { if (err.code === 11000) throw new HttpError(409, 'A website audit is already running'); throw err; }
  const runId = audit.startedAt;
  res.status(202).json({ audit });
  (async () => {
    try {
      const [services, google] = await Promise.all([Service.find({ business: req.business._id, active: true }).lean(), GoogleAccount.findOne({ business: req.business._id }).lean()]);
      const report = await crawlWebsite(url, { business: req.business.toObject(), services, google });
      await WebsiteAudit.updateOne({ _id: audit._id, startedAt: runId }, { status: 'completed', completedAt: new Date(), report, $unset: { error: 1 } });
    } catch (err) { await WebsiteAudit.updateOne({ _id: audit._id, startedAt: runId }, { status: 'failed', error: err.message, completedAt: new Date() }).catch(() => {}); }
  })();
}));
