import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse, notFound, badRequest, paginate } from '../../utils/http.js';
import { ReviewRequest, Customer, Service } from '../../models/index.js';
import { randomToken } from '../../utils/crypto.js';
import { env } from '../../config/env.js';
import { generateRequestMessage, suggestTopics } from '../ai/service.js';
import { usableReviewLink } from '../../utils/review-link.js';

export const requestsRouter = Router();
requestsRouter.use(requireAuth, requireBusiness);

export const trackingLink = (token) => `${env.appUrl}/r/${token}`;

function waNumber(phone, country = 'IN') {
  let d = String(phone || '').replace(/\D/g, '');
  if (country === 'IN' && d.length === 10) d = `91${d}`;
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  return d;
}

/** Builds the link that opens the business's own WhatsApp / SMS / email app with the message filled in. */
export function deliveryLink(request, customer, business) {
  const msg = request.message;
  switch (request.channel) {
    case 'whatsapp': return customer.phone ? `https://wa.me/${waNumber(customer.phone, business.address?.country)}?text=${encodeURIComponent(msg)}` : null;
    case 'sms': return customer.phone ? `sms:${customer.phone}?&body=${encodeURIComponent(msg)}` : null;
    case 'email': return customer.email ? `mailto:${customer.email}?subject=${encodeURIComponent(`How was your visit to ${business.name}?`)}&body=${encodeURIComponent(msg)}` : null;
    default: return null;
  }
}

requestsRouter.get('/', ah(async (req, res) => {
  const { page, limit, skip } = paginate(req.query, { defaultLimit: 50 });
  const filter = { business: req.business._id };
  if (req.query.status && ['draft', 'scheduled', 'sent', 'clicked', 'reviewed'].includes(String(req.query.status))) filter.status = req.query.status;
  const [requests, total, byStatus] = await Promise.all([
    ReviewRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('customer', 'name phone email').populate('review', 'rating comment createTime').lean(),
    ReviewRequest.countDocuments(filter),
    ReviewRequest.aggregate([{ $match: { business: req.business._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).catch(() => []),
  ]);
  const counts = Object.fromEntries(byStatus.map((s) => [s._id, s.n]));
  res.json({ requests: requests.map((r) => ({ ...r, link: trackingLink(r.token) })), total, page, limit, counts });
}));

const createSchema = z.object({
  customerId: z.string().min(1, 'Choose a customer'),
  serviceId: z.string().optional().nullable(),
  visitDate: z.coerce.date().optional(),
  channel: z.enum(['whatsapp', 'sms', 'email', 'copy']).default('whatsapp'),
  scheduledFor: z.coerce.date().optional(),
});

/** Creates a draft request with an AI-written, personalised message. */
requestsRouter.post('/', ah(async (req, res) => {
  const body = parse(createSchema, req.body);
  const customer = await Customer.findOne({ _id: body.customerId, business: req.business._id });
  if (!customer) throw notFound('Customer');
  const service = body.serviceId ? await Service.findOne({ _id: body.serviceId, business: req.business._id }) : null;
  const lastVisit = customer.visits?.at(-1);
  const serviceName = service?.name || lastVisit?.serviceName || '';
  if (!usableReviewLink(req.business.reviewLink)) throw badRequest('Add your Google review link first in Settings → Google review link (or connect Google)');

  const token = randomToken(9);
  const link = trackingLink(token);
  const [{ text, model }, topics] = await Promise.all([
    generateRequestMessage({ customer, serviceName, visitDate: body.visitDate || lastVisit?.date, business: req.business, link, channel: body.channel }),
    service?.reviewTopics?.length ? Promise.resolve(service.reviewTopics) : suggestTopics({ serviceName, business: req.business }),
  ]);

  const request = await ReviewRequest.create({
    business: req.business._id,
    customer: customer._id,
    service: service?._id,
    serviceName,
    visitDate: body.visitDate || lastVisit?.date,
    channel: body.channel,
    message: text,
    model,
    token,
    topics,
    status: body.scheduledFor ? 'scheduled' : 'draft',
    scheduledFor: body.scheduledFor,
  });
  res.status(201).json({ request: { ...request.toObject(), link }, deliveryLink: deliveryLink(request, customer, req.business), customer });
}));

requestsRouter.patch('/:id', ah(async (req, res) => {
  const body = parse(z.object({ message: z.string().trim().min(1).max(1000).optional(), channel: z.enum(['whatsapp', 'sms', 'email', 'copy']).optional(), topics: z.array(z.string().max(60)).max(6).optional() }), req.body);
  const request = await ReviewRequest.findOne({ _id: req.params.id, business: req.business._id }).populate('customer');
  if (!request) throw notFound('Request');
  Object.assign(request, body);
  if (body.message && !body.message.includes(request.token)) request.message = `${body.message}\n${trackingLink(request.token)}`;
  await request.save();
  res.json({ request: { ...request.toObject(), link: trackingLink(request.token) }, deliveryLink: deliveryLink(request, request.customer, req.business) });
}));

/** Marks a request as sent (the business sent it from WhatsApp/SMS/email or copied it). */
requestsRouter.post('/:id/sent', ah(async (req, res) => {
  const request = await ReviewRequest.findOne({ _id: req.params.id, business: req.business._id });
  if (!request) throw notFound('Request');
  if (!['clicked', 'reviewed'].includes(request.status)) request.status = 'sent';
  request.sentAt = request.sentAt || new Date();
  await request.save();
  await Customer.updateOne({ _id: request.customer, reviewStatus: { $in: ['none'] } }, { reviewStatus: 'requested', lastRequestedAt: new Date() });
  await Customer.updateOne({ _id: request.customer }, { lastRequestedAt: new Date() });
  res.json({ request });
}));

/** Manual attribution when the business knows the customer reviewed. */
requestsRouter.post('/:id/reviewed', ah(async (req, res) => {
  const request = await ReviewRequest.findOne({ _id: req.params.id, business: req.business._id });
  if (!request) throw notFound('Request');
  request.status = 'reviewed';
  request.reviewedAt = new Date();
  request.attribution = 'manual';
  await request.save();
  await Customer.updateOne({ _id: request.customer }, { reviewStatus: 'reviewed' });
  res.json({ request });
}));

requestsRouter.delete('/:id', ah(async (req, res) => {
  const result = await ReviewRequest.deleteOne({ _id: req.params.id, business: req.business._id });
  if (!result.deletedCount) throw notFound('Request');
  res.json({ ok: true });
}));
