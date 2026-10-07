import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse, notFound, paginate, badRequest } from '../../utils/http.js';
import { Review, AiResponse, GoogleAccount, Service } from '../../models/index.js';
import { analyzeAndStore, draftReply, publishReply } from './service.js';
import * as google from '../google/client.js';

export const reviewsRouter = Router();
reviewsRouter.use(requireAuth, requireBusiness);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildFilter(businessId, q) {
  const filter = { business: businessId };
  switch (q.filter) {
    case 'unanswered': filter.status = { $in: ['unanswered', 'drafted'] }; break;
    case 'answered': filter.status = 'answered'; break;
    case 'positive': filter.rating = { $gte: 4 }; break;
    case 'neutral': filter.rating = 3; break;
    case 'negative': filter.rating = { $lte: 2 }; break;
    case 'drafted': filter.status = 'drafted'; break;
    case 'direct': filter.source = 'direct'; break;
    default: break;
  }
  if (q.rating && /^[1-5]$/.test(q.rating)) filter.rating = Number(q.rating);
  if (q.sentiment && ['positive', 'neutral', 'negative', 'mixed'].includes(q.sentiment)) filter['analysis.sentiment'] = q.sentiment;
  if (q.service) filter['analysis.services'] = q.service;
  if (q.topic) filter.$or = [{ 'analysis.positives': q.topic }, { 'analysis.negatives': q.topic }];
  if (q.q) {
    const rx = new RegExp(escape(String(q.q)), 'i');
    filter.$and = [...(filter.$and || []), { $or: [{ comment: rx }, { 'reviewer.name': rx }] }];
  }
  return filter;
}

reviewsRouter.get('/', ah(async (req, res) => {
  const { page, limit, skip } = paginate(req.query, { defaultLimit: 20 });
  const filter = buildFilter(req.business._id, req.query);
  const sort = req.query.sort === 'oldest' ? { createTime: 1 } : req.query.sort === 'lowest' ? { rating: 1, createTime: -1 } : req.query.sort === 'highest' ? { rating: -1, createTime: -1 } : { createTime: -1 };
  const [reviews, total, counts] = await Promise.all([
    Review.find(filter).sort(sort).skip(skip).limit(limit).populate('customer', 'name phone').lean(),
    Review.countDocuments(filter),
    countsFor(req.business._id),
  ]);
  const drafts = await AiResponse.find({ review: { $in: reviews.map((r) => r._id) }, status: { $in: ['draft', 'approved'] } }).sort({ createdAt: -1 }).lean();
  const draftByReview = new Map();
  for (const d of drafts) if (!draftByReview.has(String(d.review))) draftByReview.set(String(d.review), d);
  res.json({
    reviews: reviews.map((r) => ({ ...r, draft: draftByReview.get(String(r._id)) || null })),
    total, page, limit, counts,
  });
}));

async function countsFor(businessId) {
  const base = { business: businessId };
  const [all, unanswered, answered, positive, neutral, negative, direct] = await Promise.all([
    Review.countDocuments(base),
    Review.countDocuments({ ...base, status: { $in: ['unanswered', 'drafted'] } }),
    Review.countDocuments({ ...base, status: 'answered' }),
    Review.countDocuments({ ...base, rating: { $gte: 4 } }),
    Review.countDocuments({ ...base, rating: 3 }),
    Review.countDocuments({ ...base, rating: { $lte: 2 } }),
    Review.countDocuments({ ...base, source: 'direct' }),
  ]);
  return { all, unanswered, answered, positive, neutral, negative, direct };
}

async function loadReview(req) {
  const review = await Review.findOne({ _id: req.params.id, business: req.business._id });
  if (!review) throw notFound('Review');
  return review;
}

reviewsRouter.get('/:id', ah(async (req, res) => {
  const review = await Review.findOne({ _id: req.params.id, business: req.business._id }).populate('customer', 'name phone email visits').populate('reviewRequest');
  if (!review) throw notFound('Review');
  const responses = await AiResponse.find({ review: review._id }).sort({ createdAt: -1 }).limit(10).lean();
  res.json({ review, responses });
}));

reviewsRouter.post('/:id/analyze', ah(async (req, res) => {
  const review = await loadReview(req);
  await analyzeAndStore(review, req.business);
  res.json({ review });
}));

reviewsRouter.post('/:id/draft', ah(async (req, res) => {
  const body = parse(z.object({ tone: z.enum(['warm', 'professional', 'playful', 'concise']).optional(), instruction: z.string().max(300).optional() }), req.body || {});
  const review = await loadReview(req);
  const draft = await draftReply(review, req.business, body);
  res.status(201).json({ draft, review });
}));

reviewsRouter.patch('/:id/draft/:draftId', ah(async (req, res) => {
  const body = parse(z.object({ text: z.string().trim().min(1).max(4096) }), req.body);
  const draft = await AiResponse.findOne({ _id: req.params.draftId, review: req.params.id, business: req.business._id });
  if (!draft) throw notFound('Draft');
  draft.finalText = body.text;
  draft.edited = body.text !== draft.text;
  await draft.save();
  res.json({ draft });
}));

/** Stop an automatic reply from posting; it stays as a draft for you to approve. */
reviewsRouter.post('/:id/draft/:draftId/hold', ah(async (req, res) => {
  const draft = await AiResponse.findOneAndUpdate(
    { _id: req.params.draftId, review: req.params.id, business: req.business._id, status: 'draft' },
    { $unset: { autoPublishAt: 1 } },
    { new: true }
  );
  if (!draft) throw notFound('Draft');
  res.json({ draft });
}));

reviewsRouter.post('/:id/approve', ah(async (req, res) => {
  const body = parse(z.object({ draftId: z.string(), text: z.string().trim().min(1).max(4096) }), req.body);
  const draft = await AiResponse.findOne({ _id: body.draftId, review: req.params.id, business: req.business._id });
  if (!draft) throw notFound('Draft');
  draft.finalText = body.text;
  draft.edited = body.text !== draft.text;
  draft.status = 'approved';
  draft.approvedBy = req.user._id;
  draft.approvedAt = new Date();
  await draft.save();
  res.json({ draft });
}));

reviewsRouter.post('/:id/publish', ah(async (req, res) => {
  const body = parse(z.object({ text: z.string().trim().min(1, 'Write a reply first').max(4096), draftId: z.string().optional() }), req.body);
  const review = await loadReview(req);
  const result = await publishReply({ review, business: req.business, user: req.user, text: body.text, aiResponseId: body.draftId });
  res.json(result);
}));

reviewsRouter.delete('/:id/reply', ah(async (req, res) => {
  const review = await loadReview(req);
  if (!review.reply?.comment) throw badRequest('This review has no reply');
  if (review.source === 'google') {
    const account = await GoogleAccount.findOne({ business: req.business._id }).select('+accessTokenEnc +refreshTokenEnc');
    if (!account || account.mode !== 'live') throw badRequest('Connect Google to remove replies');
    await google.deleteReply(account, review.googleReviewId);
  }
  review.reply = undefined;
  review.status = 'unanswered';
  await review.save();
  res.json({ review });
}));

reviewsRouter.post('/analyze-pending', ah(async (req, res) => {
  const pending = await Review.find({ business: req.business._id, 'analysis.analyzedAt': { $exists: false } }).limit(25);
  const services = await Service.find({ business: req.business._id, active: true }).lean();
  for (const r of pending) await analyzeAndStore(r, req.business, services);
  const remaining = await Review.countDocuments({ business: req.business._id, 'analysis.analyzedAt': { $exists: false } });
  res.json({ analyzed: pending.length, remaining });
}));
