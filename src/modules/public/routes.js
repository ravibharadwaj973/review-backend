import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { ReviewRequest, Business, Customer, Service } from '../../models/index.js';
import { ah, notFound, parse, HttpError } from '../../utils/http.js';
import { composeCustomerReview } from '../ai/service.js';
import { Review } from '../../models/index.js';
import { processNewReviews } from '../reviews/service.js';
import { randomToken } from '../../utils/crypto.js';
import { googleReviewTarget } from '../../utils/review-link.js';

/**
 * Public, no-auth endpoints customers use:
 *   /r/:token  — personal review link sent to one customer (tracked per request)
 *   /b/:slug   — the business's QR code / shareable link (tracked per business)
 * Every customer gets the same path to Google whatever their rating — no gating.
 */
export const publicRouter = Router();

const BASE_ASPECTS = ['Staff behaviour', 'Service quality', 'Cleanliness', 'Waiting time', 'Value for money', 'Ambience'];

async function pageData(business, { firstName = '', serviceName = '', topics = [] } = {}) {
  const services = await Service.find({ business: business._id, active: true }).select('name category reviewTopics').sort({ category: 1, sortOrder: 1, name: 1 }).lean();
  return {
    business: { name: business.name, category: business.category, logoUrl: business.logoUrl, city: business.address?.city },
    firstName,
    serviceName,
    topics,
    // The "Post on Google" button is always shown. exactGoogleLink = it opens the business's own review form.
    hasReviewLink: true,
    exactGoogleLink: googleReviewTarget(business).exact,
    // Everything the business offers, so the customer can tick what they actually took
    services: services.map((s) => ({ name: s.name, category: s.category })),
    staff: (business.staff || []).map((s) => s.name).filter(Boolean),
    // Neutral things to rate; the customer decides if each was good or could be better
    aspects: [...new Set([...topics, ...BASE_ASPECTS])].slice(0, 9),
  };
}

const BUSINESS_FIELDS = 'name category logoUrl reviewLink address.city staff slug account.status';
const PAUSED = () => new HttpError(404, 'This page isn’t available right now.');

const composeSchema = z.object({
  rating: z.number().int().min(1).max(5),
  services: z.array(z.string().max(140)).max(10).default([]),
  liked: z.array(z.string().max(60)).max(10).default([]),
  disliked: z.array(z.string().max(60)).max(10).default([]),
  note: z.string().max(600).default(''),
  staff: z.string().max(80).default(''),
  length: z.enum(['short', 'detailed']).default('short'),
  variant: z.number().int().min(0).max(20).default(0),
});

const composeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.params.token || req.params.slug}:${req.ip}`,
});

/* ---- Personal review link (/r/:token) ----------------------------------- */

publicRouter.get('/r/:token', ah(async (req, res) => {
  const request = await ReviewRequest.findOne({ token: req.params.token }).populate('customer', 'name');
  if (!request) throw notFound('Link');
  const business = await Business.findById(request.business).select(BUSINESS_FIELDS).lean();
  if (!business) throw notFound('Link');
  if (business.account?.status === 'suspended') throw PAUSED();
  if (!request.openedAt) {
    request.openedAt = new Date();
    await request.save();
  }
  res.json(await pageData(business, { firstName: (request.customer?.name || '').split(/\s+/)[0], serviceName: request.serviceName, topics: request.topics || [] }));
}));

/** Records the click and forwards the customer to Google's review form. */
publicRouter.get('/r/:token/go', ah(async (req, res) => {
  const request = await ReviewRequest.findOne({ token: req.params.token });
  if (!request) throw notFound('Link');
  const business = await Business.findById(request.business).select('name reviewLink address.city').lean();
  if (!business) throw notFound('Link');
  request.clicks = (request.clicks || 0) + 1;
  request.clickedAt = request.clickedAt || new Date();
  if (['draft', 'sent', 'scheduled'].includes(request.status)) request.status = 'clicked';
  if (!request.sentAt) request.sentAt = new Date();
  await request.save();
  await Customer.updateOne({ _id: request.customer, reviewStatus: { $in: ['none', 'requested'] } }, { reviewStatus: 'clicked' });
  res.redirect(302, googleReviewTarget(business).url);
}));

/**
 * Helps the customer put their own experience into words. Built only from what they chose
 * and typed. The customer edits and posts it on Google themselves — nothing is posted here.
 */
publicRouter.post('/r/:token/compose', composeLimiter, ah(async (req, res) => {
  const body = parse(composeSchema, req.body);
  const request = await ReviewRequest.findOne({ token: req.params.token });
  if (!request) throw notFound('Link');
  if ((request.composeCount || 0) >= 25) throw new HttpError(429, 'You’ve tried a lot of versions. Please write the rest in your own words.');
  const business = await Business.findById(request.business).select('name category').lean();
  const result = await composeCustomerReview({ business, ...body });
  await ReviewRequest.updateOne({ _id: request._id }, { $inc: { composeCount: 1 } });
  res.json(result);
}));

/* ---- Business QR code / shareable link (/b/:slug) ----------------------- */

async function bySlug(slug) {
  const business = await Business.findOne({ slug: String(slug).toLowerCase() }).select(BUSINESS_FIELDS);
  if (!business) throw notFound('Business');
  if (business.account?.status === 'suspended') throw PAUSED();
  return business;
}

publicRouter.get('/b/:slug', ah(async (req, res) => {
  const business = await bySlug(req.params.slug);
  await Business.updateOne({ _id: business._id }, { $inc: { 'qrStats.opens': 1 }, $set: { 'qrStats.lastOpenAt': new Date() } });
  res.json(await pageData(business));
}));

publicRouter.get('/b/:slug/go', ah(async (req, res) => {
  const business = await bySlug(req.params.slug);
  await Business.updateOne({ _id: business._id }, { $inc: { 'qrStats.clicks': 1 } });
  res.redirect(302, googleReviewTarget(business).url);
}));

publicRouter.post('/b/:slug/compose', composeLimiter, ah(async (req, res) => {
  const body = parse(composeSchema, req.body);
  const business = await bySlug(req.params.slug);
  const result = await composeCustomerReview({ business, ...body });
  await Business.updateOne({ _id: business._id }, { $inc: { 'qrStats.composed': 1 } });
  res.json(result);
}));

/* ---- Submit a review in ReviewRankr (no login) ------------------------------ */

const submitSchema = z.object({
  rating: z.number().int().min(1, 'Choose a star rating').max(5),
  text: z.string().trim().max(4000).default(''),
  services: z.array(z.string().max(140)).max(10).default([]),
  name: z.string().trim().max(80).default(''),
  website: z.string().max(0, 'Spam check failed').optional(), // honeypot: real people never fill this
});

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reviews from this device. Please try again later.' },
});

async function saveDirectReview({ business, body, via, customer, request }) {
  const review = await Review.create({
    business: business._id,
    source: 'direct',
    submittedVia: via,
    googleReviewId: `direct-${randomToken(10)}`,
    reviewer: { name: body.name || customer?.name || 'Customer', isAnonymous: !body.name && !customer },
    rating: body.rating,
    comment: body.text,
    services: body.services,
    createTime: new Date(),
    updateTime: new Date(),
    status: 'unanswered',
    customer: customer?._id,
    reviewRequest: request?._id,
  });
  // Analyse and draft a reply in the background so the customer isn't kept waiting
  const full = await Business.findById(business._id);
  processNewReviews(full, [review]).catch((err) => console.warn('[public] review pipeline failed:', err.message));
  return review;
}

publicRouter.post('/r/:token/submit', submitLimiter, ah(async (req, res) => {
  const body = parse(submitSchema, req.body);
  const request = await ReviewRequest.findOne({ token: req.params.token }).populate('customer', 'name');
  if (!request) throw notFound('Link');
  if (request.review && request.attribution === 'direct') throw new HttpError(409, 'You’ve already sent a review with this link. Thank you!');
  const business = await Business.findById(request.business).select(BUSINESS_FIELDS);
  if (!business) throw notFound('Link');
  const review = await saveDirectReview({ business, body, via: 'link', customer: request.customer, request });
  request.status = 'reviewed';
  request.reviewedAt = new Date();
  request.review = review._id;
  request.attribution = 'direct';
  await request.save();
  if (request.customer) await Customer.updateOne({ _id: request.customer._id }, { reviewStatus: 'reviewed', googleReview: review._id });
  res.status(201).json({ ok: true, hasReviewLink: true });
}));

publicRouter.post('/b/:slug/submit', submitLimiter, ah(async (req, res) => {
  const body = parse(submitSchema, req.body);
  const business = await bySlug(req.params.slug);
  await saveDirectReview({ business, body, via: 'qr' });
  await Business.updateOne({ _id: business._id }, { $inc: { 'qrStats.submitted': 1 } });
  res.status(201).json({ ok: true, hasReviewLink: true });
}));
