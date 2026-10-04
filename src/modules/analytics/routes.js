import { Router } from 'express';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah } from '../../utils/http.js';
import { Review, AiResponse, GoogleAccount } from '../../models/index.js';
import { reviewOverview, topicStats, requestFunnel, aiMetrics } from './service.js';
import { generateInsights } from '../ai/service.js';

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth, requireBusiness);

/** Everything the home dashboard needs in one call. */
analyticsRouter.get('/dashboard', ah(async (req, res) => {
  const id = req.business._id;
  const [overview, topics, funnel, ai, needsReply, latest, google] = await Promise.all([
    reviewOverview(id),
    topicStats(id),
    requestFunnel(id),
    aiMetrics(id),
    Review.find({ business: id, status: { $in: ['unanswered', 'drafted'] } }).sort({ rating: 1, createTime: -1 }).limit(3).lean(),
    Review.find({ business: id }).sort({ createTime: -1 }).limit(5).lean(),
    GoogleAccount.findOne({ business: id }).lean(),
  ]);
  const drafts = await AiResponse.find({ review: { $in: needsReply.map((r) => r._id) }, status: 'draft' }).lean();
  const draftMap = new Map(drafts.map((d) => [String(d.review), d]));
  res.json({
    overview,
    topics: { praised: topics.praised.slice(0, 5), criticized: topics.criticized.slice(0, 5), analyzed: topics.analyzed },
    funnel,
    ai,
    needsReply: needsReply.map((r) => ({ ...r, draft: draftMap.get(String(r._id)) || null })),
    latest,
    google: google ? { mode: google.mode, status: google.status, lastSyncAt: google.lastSyncAt, locationTitle: google.locationTitle } : null,
    onboarding: req.business.onboarding,
  });
}));

analyticsRouter.get('/reviews', ah(async (req, res) => res.json(await reviewOverview(req.business._id))));

analyticsRouter.get('/topics', ah(async (req, res) => {
  const days = Number(req.query.days) || 0;
  res.json(await topicStats(req.business._id, { since: days ? new Date(Date.now() - days * 864e5) : undefined }));
}));

analyticsRouter.get('/requests', ah(async (req, res) => res.json(await requestFunnel(req.business._id))));
analyticsRouter.get('/ai', ah(async (req, res) => res.json(await aiMetrics(req.business._id))));

// Insights are cached briefly per business to keep AI usage low.
const insightCache = new Map();
analyticsRouter.get('/insights', ah(async (req, res) => {
  const key = String(req.business._id);
  const cached = insightCache.get(key);
  if (cached && req.query.refresh !== '1' && Date.now() - cached.at < 60 * 60 * 1000) return res.json(cached.value);
  const [overview, topics] = await Promise.all([reviewOverview(req.business._id), topicStats(req.business._id)]);
  const totals = { reviews: overview.total, avgRating: overview.avgRating, unanswered: overview.unanswered, responseRate: overview.responseRate, thisMonth: overview.thisMonth, lastMonth: overview.lastMonth };
  const value = { ...(await generateInsights({ business: req.business, praised: topics.praised, criticized: topics.criticized, totals, byService: topics.byService })), generatedAt: new Date() };
  insightCache.set(key, { at: Date.now(), value });
  res.json(value);
}));
