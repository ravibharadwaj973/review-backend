import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse, notFound, paginate } from '../../utils/http.js';
import { Customer, Service, ReviewRequest } from '../../models/index.js';

export const customersRouter = Router();
customersRouter.use(requireAuth, requireBusiness);

const customerSchema = z.object({
  name: z.string().trim().min(1, 'Enter the customer name').max(120),
  phone: z.string().trim().max(30).optional().default(''),
  email: z.union([z.literal(''), z.string().trim().email('Enter a valid email')]).optional().default(''),
  notes: z.string().max(1000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  consent: z.boolean().optional(),
});

const visitSchema = z.object({
  serviceId: z.string().optional(),
  serviceName: z.string().max(140).optional(),
  date: z.coerce.date().optional(),
  amount: z.number().min(0).optional(),
});

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

customersRouter.get('/', ah(async (req, res) => {
  const { page, limit, skip } = paginate(req.query, { defaultLimit: 50, maxLimit: 200 });
  const filter = { business: req.business._id };
  if (req.query.q) {
    const rx = new RegExp(escape(String(req.query.q)), 'i');
    filter.$or = [{ name: rx }, { phone: rx }, { email: rx }];
  }
  const seg = String(req.query.segment || '');
  if (['none', 'requested', 'clicked', 'reviewed'].includes(seg)) filter.reviewStatus = seg;
  if (seg === 'first_time') filter['visits.1'] = { $exists: false };
  if (seg === 'returning') filter['visits.1'] = { $exists: true };
  if (seg === 'lapsed') filter.lastVisit = { $lt: new Date(Date.now() - 45 * 864e5) };
  if (seg === 'not_requested') filter.reviewStatus = 'none';

  const [customers, total] = await Promise.all([
    Customer.find(filter).sort({ lastVisit: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    Customer.countDocuments(filter),
  ]);
  res.json({ customers, total, page, limit });
}));

customersRouter.get('/:id', ah(async (req, res) => {
  const customer = await Customer.findOne({ _id: req.params.id, business: req.business._id }).populate('googleReview');
  if (!customer) throw notFound('Customer');
  const requests = await ReviewRequest.find({ customer: customer._id }).sort({ createdAt: -1 }).limit(20).lean();
  res.json({ customer, requests });
}));

async function resolveVisit(business, v) {
  if (!v) return null;
  let serviceName = v.serviceName;
  let service;
  if (v.serviceId) {
    service = await Service.findOne({ _id: v.serviceId, business: business._id });
    serviceName = service?.name || serviceName;
  }
  return { service: service?._id, serviceName, date: v.date || new Date(), amount: v.amount };
}

customersRouter.post('/', ah(async (req, res) => {
  const body = parse(customerSchema.extend({ visit: visitSchema.optional() }), req.body);
  const { visit, ...data } = body;
  const customer = new Customer({ ...data, business: req.business._id });
  const v = await resolveVisit(req.business, visit);
  if (v) customer.visits.push(v);
  await customer.save();
  res.status(201).json({ customer });
}));

customersRouter.post('/import', ah(async (req, res) => {
  const body = parse(
    z.object({
      rows: z.array(z.object({ name: z.string().trim().min(1), phone: z.string().optional(), email: z.string().optional(), service: z.string().optional(), date: z.string().optional() })).min(1).max(2000),
    }),
    req.body
  );
  const services = await Service.find({ business: req.business._id }).lean();
  let created = 0;
  let updated = 0;
  for (const row of body.rows) {
    const phone = (row.phone || '').trim();
    const email = (row.email || '').trim().toLowerCase();
    let customer = phone || email
      ? await Customer.findOne({ business: req.business._id, $or: [phone ? { phone } : null, email ? { email } : null].filter(Boolean) })
      : null;
    if (!customer) {
      customer = new Customer({ business: req.business._id, name: row.name, phone, email: /\S+@\S+/.test(email) ? email : '' });
      created += 1;
    } else updated += 1;
    if (row.service) {
      const svc = services.find((s) => s.name.toLowerCase() === row.service.trim().toLowerCase());
      const date = row.date && !Number.isNaN(Date.parse(row.date)) ? new Date(row.date) : new Date();
      customer.visits.push({ service: svc?._id, serviceName: svc?.name || row.service.trim(), date });
    }
    await customer.save();
  }
  res.json({ created, updated });
}));

customersRouter.patch('/:id', ah(async (req, res) => {
  const body = parse(customerSchema.partial(), req.body);
  const customer = await Customer.findOneAndUpdate({ _id: req.params.id, business: req.business._id }, body, { new: true, runValidators: true });
  if (!customer) throw notFound('Customer');
  res.json({ customer });
}));

customersRouter.post('/:id/visits', ah(async (req, res) => {
  const body = parse(visitSchema, req.body);
  const customer = await Customer.findOne({ _id: req.params.id, business: req.business._id });
  if (!customer) throw notFound('Customer');
  customer.visits.push(await resolveVisit(req.business, body));
  await customer.save();
  res.status(201).json({ customer });
}));

customersRouter.delete('/:id', ah(async (req, res) => {
  const result = await Customer.deleteOne({ _id: req.params.id, business: req.business._id });
  if (!result.deletedCount) throw notFound('Customer');
  await ReviewRequest.deleteMany({ customer: req.params.id, business: req.business._id });
  res.json({ ok: true });
}));
