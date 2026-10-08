import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireAuth, requireAdmin, signToken } from '../../middleware/auth.js';
import { ah, parse, notFound, badRequest, conflict, paginate } from '../../utils/http.js';
import {
  Business, User, GoogleAccount, Review, AiResponse, ReviewRequest, Photo, Post, Customer, Service, Location, Question,
  Plan, Invoice, Payment, AdminLog, Setting, CYCLES, PAYMENT_METHODS,
} from '../../models/index.js';
import { env, googleConfigured, isAdminUrl } from '../../config/env.js';
import { syncReviews, refreshRemoteSnapshot, loadAccount } from '../google/sync.js';
import { normalizeReviewLink, usableReviewLink } from '../../utils/review-link.js';
import {
  accountState, allocatePayment, billingSummary, createInvoice, invoiceDocument, invoiceNextPeriod, log, recalcInvoice, refreshAccount, addMonths,
} from '../billing/service.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

const oid = (id) => (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plain = (v) => (v?.toObject ? v.toObject() : v || {});
const round = (n) => Math.round(Number(n || 0) * 100) / 100;

async function loadBusiness(id, extra = '') {
  const b = oid(id) && (await Business.findById(id).select(`+adminNotes ${extra}`.trim()));
  if (!b) throw notFound('Account');
  return b;
}

/* ------------------------------------------------------------------ overview */

adminRouter.get('/overview', ah(async (_req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [total, suspended, trials, google, openInv, collectedMonth, collectedAll, pendingPayments, recentPayments, recentSignups, reviews, signupsByMonth, revenueByMonth] = await Promise.all([
    Business.countDocuments(),
    Business.countDocuments({ 'account.status': 'suspended' }),
    Business.countDocuments({ 'account.status': { $ne: 'suspended' }, 'account.trialEndsAt': { $gt: now }, 'account.paidUntil': { $exists: false } }),
    GoogleAccount.find().select('mode status').lean().then((list) => ['live', 'demo'].map((mode) => ({
      _id: mode,
      n: list.filter((a) => a.mode === mode).length,
      errors: list.filter((a) => a.mode === mode && ['error', 'revoked'].includes(a.status)).length,
    }))),
    Invoice.find({ status: { $in: ['pending', 'partial'] } }).select('balance dueDate business').lean(),
    Payment.aggregate([{ $match: { status: 'confirmed', paidAt: { $gte: monthStart } } }, { $group: { _id: null, sum: { $sum: '$amount' } } }]),
    Payment.aggregate([{ $match: { status: 'confirmed' } }, { $group: { _id: null, sum: { $sum: '$amount' } } }]),
    Payment.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(10).populate('business', 'name').lean(),
    Payment.find({ status: 'confirmed' }).sort({ paidAt: -1 }).limit(8).populate('business', 'name').lean(),
    Business.find().sort({ createdAt: -1 }).limit(6).select('name category createdAt account.status account.trialEndsAt').lean(),
    Review.countDocuments(),
    Business.find({ createdAt: { $gte: addMonths(monthStart, -11) } }).select('createdAt').lean(),
    Payment.find({ status: 'confirmed', paidAt: { $gte: addMonths(monthStart, -11) } }).select('paidAt amount').lean(),
  ]);
  const overdue = openInv.filter((i) => i.dueDate && i.dueDate < now);
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = addMonths(monthStart, i - 11);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const g = Object.fromEntries(google.map((x) => [x._id, x]));
  const ym = (d) => `${new Date(d).getFullYear()}-${String(new Date(d).getMonth() + 1).padStart(2, '0')}`;
  res.json({
    accounts: { total, active: total - suspended, suspended, trials },
    money: {
      collectedThisMonth: round(collectedMonth[0]?.sum),
      collectedAllTime: round(collectedAll[0]?.sum),
      outstanding: round(openInv.reduce((s, i) => s + i.balance, 0)),
      overdue: round(overdue.reduce((s, i) => s + i.balance, 0)),
      overdueAccounts: new Set(overdue.map((i) => String(i.business))).size,
    },
    google: { configured: googleConfigured(), live: g.live?.n || 0, demo: g.demo?.n || 0, errors: (g.live?.errors || 0), none: Math.max(0, total - (g.live?.n || 0) - (g.demo?.n || 0)) },
    reviews,
    pendingPayments,
    recentPayments,
    recentSignups,
    series: months.map((m) => ({
      month: m,
      signups: signupsByMonth.filter((x) => ym(x.createdAt) === m).length,
      revenue: round(revenueByMonth.filter((x) => ym(x.paidAt) === m).reduce((sum, x) => sum + x.amount, 0)),
    })),
  });
}));

/* ------------------------------------------------------------------ accounts */

adminRouter.get('/accounts', ah(async (req, res) => {
  const { page, limit, skip } = paginate(req.query, { defaultLimit: 50, maxLimit: 200 });
  const filter = {};
  if (req.query.q) {
    const rx = new RegExp(escape(String(req.query.q)), 'i');
    const owners = await User.find({ $or: [{ email: rx }, { name: rx }] }).select('_id').lean();
    filter.$or = [{ name: rx }, { phone: rx }, { 'address.city': rx }, { owner: { $in: owners.map((o) => o._id) } }];
  }
  if (req.query.status === 'suspended') filter['account.status'] = 'suspended';
  if (req.query.status === 'active') filter['account.status'] = { $ne: 'suspended' };
  if (req.query.plan && oid(req.query.plan)) filter['account.plan'] = oid(req.query.plan);

  let businesses = await Business.find(filter).sort({ createdAt: -1 }).populate('owner', 'name email lastLoginAt').populate('account.plan', 'name price billingCycle').lean();
  const ids = businesses.map((b) => b._id);
  const [inv, google, reviewCounts] = await Promise.all([
    Invoice.find({ business: { $in: ids }, status: { $in: ['pending', 'partial'] } }).select('business balance dueDate').lean().then((list) => {
      const by = {};
      for (const i of list) {
        const k = String(i.business);
        by[k] = by[k] || { _id: k, balance: 0, firstDue: null };
        by[k].balance += i.balance;
        if (i.dueDate && (!by[k].firstDue || i.dueDate < by[k].firstDue)) by[k].firstDue = i.dueDate;
      }
      return Object.values(by);
    }),
    GoogleAccount.find({ business: { $in: ids } }).select('business mode status locationTitle lastSyncAt lastError').lean(),
    Review.aggregate([{ $match: { business: { $in: ids } } }, { $group: { _id: '$business', n: { $sum: 1 }, total: { $sum: '$rating' } } }]),
  ]);
  const invBy = new Map(inv.map((x) => [String(x._id), x]));
  const gBy = new Map(google.map((x) => [String(x.business), x]));
  const rBy = new Map(reviewCounts.map((x) => [String(x._id), x]));
  const now = new Date();
  let rows = businesses.map((b) => {
    const i = invBy.get(String(b._id));
    const balance = round(i?.balance);
    const overdue = Boolean(i?.firstDue && i.firstDue < now && balance > 0);
    const acc = b.account || {};
    const price = acc.price != null ? acc.price : acc.plan?.price || 0;
    const discount = !acc.discountValue || acc.discountType === 'none' ? 0 : acc.discountType === 'percent' ? (price * acc.discountValue) / 100 : Math.min(price, acc.discountValue);
    const g = gBy.get(String(b._id));
    const r = rBy.get(String(b._id));
    return {
      _id: b._id, name: b.name, category: b.category, city: b.address?.city, phone: b.phone, createdAt: b.createdAt, slug: b.slug,
      owner: b.owner,
      account: { ...acc, plan: acc.plan || null },
      price, netPrice: round(price - discount),
      balance, overdue,
      state: accountState(b, { openBalance: balance, overdue }),
      google: g ? { mode: g.mode, status: g.status, location: g.locationTitle, lastSyncAt: g.lastSyncAt, error: g.lastError } : null,
      reviews: r ? { count: r.n, avg: round(r.total / r.n) } : { count: 0, avg: 0 },
    };
  });
  if (req.query.state) rows = rows.filter((r) => r.state === req.query.state);
  if (req.query.google === 'none') rows = rows.filter((r) => !r.google);
  if (['live', 'demo'].includes(String(req.query.google))) rows = rows.filter((r) => r.google?.mode === req.query.google);
  if (req.query.google === 'error') rows = rows.filter((r) => ['error', 'revoked'].includes(r.google?.status));
  res.json({ accounts: rows.slice(skip, skip + limit), total: rows.length, page, limit });
}));

const accountSchema = z.object({
  plan: z.string().nullable().optional(),
  price: z.number().min(0).max(10_000_000).nullable().optional(),
  discountType: z.enum(['none', 'percent', 'flat']).optional(),
  discountValue: z.number().min(0).max(10_000_000).optional(),
  billingCycle: z.enum(CYCLES).optional(),
  trialEndsAt: z.string().nullable().optional(),
  autoInvoice: z.boolean().optional(),
  adminNotes: z.string().max(4000).optional(),
  reviewLink: z.string().max(600).transform(normalizeReviewLink).refine((v) => v === '' || /^https?:\/\/[^\s]+\.[^\s]+/.test(v), 'Paste the full Google review link (https://…) or the Place ID').optional(),
}).refine((x) => !(x.discountType === 'percent' && x.discountValue > 100), { message: 'A percent discount can’t be more than 100', path: ['discountValue'] });

/** Create a business account by hand (owner gets the email + password you set). */
adminRouter.post('/accounts', ah(async (req, res) => {
  const body = parse(z.object({
    businessName: z.string().trim().min(2, 'Enter the business name').max(120),
    category: z.string().trim().max(60).optional().default('Salon'),
    phone: z.string().trim().max(30).optional().default(''),
    city: z.string().trim().max(80).optional().default(''),
    ownerName: z.string().trim().min(2, 'Enter the owner’s name').max(80),
    email: z.string().trim().email('Enter a valid email'),
    password: z.string().min(8, 'Use at least 8 characters').max(200),
    trialDays: z.number().int().min(0).max(365).optional(),
  }).and(accountSchema), req.body);
  if (await User.exists({ email: body.email.toLowerCase() })) throw conflict('A user with this email already exists');
  const settings = await Setting.get();
  const user = new User({ name: body.ownerName, email: body.email });
  await user.setPassword(body.password);
  await user.save();
  const trialDays = body.trialDays ?? settings.defaultTrialDays;
  const business = await Business.create({
    owner: user._id, name: body.businessName, category: body.category, phone: body.phone, address: { city: body.city },
    account: {
      status: 'active',
      trialEndsAt: trialDays ? new Date(Date.now() + trialDays * 864e5) : undefined,
      plan: body.plan || undefined, price: body.price ?? undefined,
      discountType: body.discountType || 'none', discountValue: body.discountValue || 0,
      billingCycle: body.billingCycle || 'monthly', autoInvoice: body.autoInvoice ?? true,
    },
    adminNotes: body.adminNotes || '',
  });
  await business.ensureSlug();
  await log(req.user._id, business._id, 'account.created', { email: body.email });
  res.status(201).json({ business });
}));

adminRouter.get('/accounts/:id', ah(async (req, res) => {
  const b = await loadBusiness(req.params.id);
  const [owner, google, location, billing, logs, stats] = await Promise.all([
    User.findById(b.owner).lean(),
    GoogleAccount.findOne({ business: b._id }).lean(),
    Location.findOne({ business: b._id }).lean(),
    billingSummary(b),
    AdminLog.find({ business: b._id }).sort({ createdAt: -1 }).limit(60).populate('admin', 'name email').lean(),
    (async () => {
      const [reviews, avg, unanswered, replies, autoReplies, requests, customers, services, photos, photosPosted, posts, questions] = await Promise.all([
        Review.countDocuments({ business: b._id }),
        Review.aggregate([{ $match: { business: b._id } }, { $group: { _id: null, t: { $sum: '$rating' }, n: { $sum: 1 } } }]),
        Review.countDocuments({ business: b._id, status: { $ne: 'answered' } }),
        AiResponse.countDocuments({ business: b._id, status: 'published' }),
        AiResponse.countDocuments({ business: b._id, status: 'draft', autoPublishAt: { $exists: true } }),
        ReviewRequest.countDocuments({ business: b._id }),
        Customer.countDocuments({ business: b._id }),
        Service.countDocuments({ business: b._id }),
        Photo.countDocuments({ business: b._id }),
        Photo.countDocuments({ business: b._id, postedAt: { $exists: true } }),
        Post.countDocuments({ business: b._id, status: 'published' }),
        Question.countDocuments({ business: b._id, status: 'answered' }),
      ]);
      return { reviews, avgRating: avg[0]?.n ? round(avg[0].t / avg[0].n) : 0, unanswered, replies, autoReplies, requests, customers, services, photos, photosPosted, posts, questions };
    })(),
  ]);
  const ownerJson = owner ? { id: owner._id, name: owner.name, email: owner.email, lastLoginAt: owner.lastLoginAt, createdAt: owner.createdAt } : null;
  const g = google ? {
    mode: google.mode, email: google.email, status: google.status, locationTitle: google.locationTitle, locationName: google.locationName,
    lastSyncAt: google.lastSyncAt, lastError: google.lastError, fetchedAt: google.remote?.fetchedAt, mapsUri: location?.google?.mapsUri, reviewUri: location?.google?.newReviewUri,
  } : null;
  res.json({
    business: { _id: b._id, name: b.name, category: b.category, phone: b.phone, email: b.email, address: b.address, slug: b.slug, createdAt: b.createdAt, reviewLink: b.reviewLink, adminNotes: b.adminNotes, links: b.links },
    owner: ownerJson, google: g, billing, stats, logs,
    publicUrl: b.slug ? `${env.appUrl}/b/${b.slug}` : null,
  });
}));

adminRouter.patch('/accounts/:id', ah(async (req, res) => {
  const body = parse(accountSchema, req.body);
  const b = await loadBusiness(req.params.id);
  const acc = plain(b.account);
  const before = { plan: acc.plan, price: acc.price, discountType: acc.discountType, discountValue: acc.discountValue, billingCycle: acc.billingCycle, trialEndsAt: acc.trialEndsAt };
  if ('plan' in body) {
    if (body.plan && !(await Plan.exists({ _id: body.plan }))) throw badRequest('Choose a plan');
    acc.plan = body.plan || undefined;
  }
  if ('price' in body) acc.price = body.price ?? undefined;
  for (const k of ['discountType', 'discountValue', 'billingCycle', 'autoInvoice']) if (k in body) acc[k] = body[k];
  if ('trialEndsAt' in body) acc.trialEndsAt = body.trialEndsAt ? new Date(body.trialEndsAt) : undefined;
  b.set('account', acc);
  if ('adminNotes' in body) b.adminNotes = body.adminNotes;
  if ('reviewLink' in body) {
    // Never cleared — only replaced with another link
    if (!body.reviewLink && usableReviewLink(b.reviewLink)) throw badRequest('The Google review link can’t be removed. Paste a new link to change it.');
    if (body.reviewLink) b.reviewLink = body.reviewLink;
  }
  await b.save();
  const changed = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'adminNotes' && k !== 'reviewLink'));
  if (Object.keys(changed).length) await log(req.user._id, b._id, 'account.updated', { before, after: changed });
  if ('adminNotes' in body) await log(req.user._id, b._id, 'account.notes', {});
  if (body.reviewLink) await log(req.user._id, b._id, 'account.review_link', { reviewLink: body.reviewLink });
  res.json({ ok: true, billing: await billingSummary(b) });
}));

/** The on/off switch: pause or resume an account. */
adminRouter.post('/accounts/:id/status', ah(async (req, res) => {
  const body = parse(z.object({ active: z.boolean(), reason: z.string().trim().max(200).optional().default('') }), req.body);
  const b = await loadBusiness(req.params.id);
  const acc = plain(b.account);
  if (body.active) Object.assign(acc, { status: 'active', suspendedReason: undefined, suspendedAt: undefined, suspendedBy: undefined });
  else Object.assign(acc, { status: 'suspended', suspendedReason: body.reason || 'Paused by admin', suspendedAt: new Date(), suspendedBy: 'admin' });
  b.set('account', acc);
  await b.save();
  await log(req.user._id, b._id, body.active ? 'account.reactivated' : 'account.suspended', { reason: body.reason });
  res.json({ ok: true, status: acc.status });
}));

/**
 * Opens the business's app as its owner (2 hours, logged). The admin app opens the returned
 * link in a new tab; the token travels in the # part of the link, which is never sent to servers.
 */
adminRouter.post('/accounts/:id/impersonate', ah(async (req, res) => {
  const body = parse(z.object({ returnUrl: z.string().url().max(500).optional() }), req.body || {});
  const b = await loadBusiness(req.params.id);
  const owner = await User.findById(b.owner);
  if (!owner) throw notFound('Owner');
  await log(req.user._id, b._id, 'account.opened_as_owner', {});
  const token = signToken(owner, { impersonatedBy: req.user._id });
  // "Back to admin" only ever goes to the admin website from ADMIN_URL (no open redirects)
  const backUrl = body.returnUrl && isAdminUrl(body.returnUrl) ? body.returnUrl : env.adminUrl;
  const back = backUrl ? `&back=${encodeURIComponent(backUrl)}` : '';
  res.json({ token, url: `${env.appUrl}/impersonate#token=${encodeURIComponent(token)}${back}`, business: { name: b.name } });
}));

adminRouter.post('/accounts/:id/reset-password', ah(async (req, res) => {
  const body = parse(z.object({ password: z.string().min(8, 'Use at least 8 characters').max(200) }), req.body);
  const b = await loadBusiness(req.params.id);
  const owner = await User.findById(b.owner).select('+passwordHash');
  if (!owner) throw notFound('Owner');
  await owner.setPassword(body.password);
  await owner.save();
  await log(req.user._id, b._id, 'owner.password_reset', {});
  res.json({ ok: true });
}));

/** Deletes the account and all its data. The name must be typed to confirm. */
adminRouter.delete('/accounts/:id', ah(async (req, res) => {
  const body = parse(z.object({ confirmName: z.string() }), req.body || {});
  const b = await loadBusiness(req.params.id);
  if (body.confirmName.trim() !== b.name) throw badRequest('Type the business name exactly to delete it');
  const models = [Service, Customer, GoogleAccount, Review, AiResponse, ReviewRequest, Photo, Location, Post, Question, Invoice, Payment];
  await Promise.all(models.map((M) => M.deleteMany({ business: b._id })));
  const ownerId = b.owner;
  await b.deleteOne();
  const otherBusiness = await Business.exists({ owner: ownerId });
  const owner = await User.findById(ownerId);
  if (owner && !otherBusiness && !owner.isAdmin()) await owner.deleteOne();
  await log(req.user._id, null, 'account.deleted', { name: b.name, id: String(b._id) });
  res.json({ ok: true });
}));

/* -------------------------------------------------------- google per account */

adminRouter.post('/accounts/:id/google/sync', ah(async (req, res) => {
  const b = await loadBusiness(req.params.id);
  const account = await loadAccount(b._id);
  if (!account) throw badRequest('This business hasn’t connected Google');
  if (account.mode === 'demo') return res.json({ demo: true, message: 'Demo connection — nothing to sync' });
  const result = await syncReviews(b);
  await refreshRemoteSnapshot(b).catch(() => null);
  await log(req.user._id, b._id, 'google.synced', result);
  res.json(result);
}));

adminRouter.delete('/accounts/:id/google', ah(async (req, res) => {
  const b = await loadBusiness(req.params.id);
  const account = await loadAccount(b._id);
  if (account) {
    if (account.mode === 'live') {
      const token = account.getRefreshToken() || account.getAccessToken();
      if (token) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
    }
    await account.deleteOne();
  }
  await Location.deleteMany({ business: b._id });
  b.onboarding.google = false;
  await b.save();
  await log(req.user._id, b._id, 'google.disconnected', {});
  res.json({ ok: true });
}));

/** Platform Google setup and every connection that needs attention. */
adminRouter.get('/google', ah(async (_req, res) => {
  const accounts = await GoogleAccount.find().populate('business', 'name account.status').sort({ updatedAt: -1 }).lean();
  res.json({
    configured: googleConfigured(),
    clientIdSet: Boolean(env.google.clientId),
    secretSet: Boolean(env.google.clientSecret),
    redirectUri: env.google.redirectUri,
    frontend: env.appUrl,
    publicAssetUrl: env.publicAssetUrl,
    connections: accounts.filter((a) => a.business).map((a) => ({
      business: { _id: a.business._id, name: a.business.name }, mode: a.mode, email: a.email, status: a.status,
      location: a.locationTitle, lastSyncAt: a.lastSyncAt, error: a.lastError,
    })),
  });
}));

/* ------------------------------------------------------------- invoices */

const money = z.number().min(0).max(10_000_000);
const dateStr = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Choose a date');

adminRouter.post('/accounts/:id/invoices', ah(async (req, res) => {
  const body = parse(z.object({
    nextPeriod: z.boolean().optional(), // bill the next period of the account's plan
    amount: money.optional(),
    discount: money.optional(),
    description: z.string().max(200).optional(),
    periodStart: dateStr.optional(),
    periodEnd: dateStr.optional(),
    dueDate: dateStr.optional(),
    notes: z.string().max(500).optional(),
  }), req.body);
  const b = await loadBusiness(req.params.id);
  let invoice;
  if (body.nextPeriod) {
    invoice = await invoiceNextPeriod(b, { createdBy: 'admin' });
    if (body.discount != null || body.notes) {
      if (body.discount != null) invoice.discount = Math.min(body.discount, invoice.amount);
      invoice.total = round(invoice.amount - invoice.discount);
      if (body.notes) invoice.notes = body.notes;
      await recalcInvoice(invoice);
    }
  } else {
    if (body.amount == null) throw badRequest('Enter the amount');
    invoice = await createInvoice(b, { ...body, createdBy: 'admin' });
  }
  await refreshAccount(b);
  await log(req.user._id, b._id, 'invoice.created', { number: invoice.number, total: invoice.total });
  res.status(201).json({ invoice });
}));

adminRouter.get('/invoices', ah(async (req, res) => {
  const filter = {};
  const now = new Date();
  if (req.query.status === 'open') filter.status = { $in: ['pending', 'partial'] };
  else if (req.query.status === 'overdue') Object.assign(filter, { status: { $in: ['pending', 'partial'] }, dueDate: { $lt: now } });
  else if (['pending', 'partial', 'paid', 'waived', 'cancelled'].includes(String(req.query.status))) filter.status = req.query.status;
  const invoices = await Invoice.find(filter).sort({ createdAt: -1 }).limit(300).populate('business', 'name').lean();
  res.json({ invoices });
}));

adminRouter.get('/invoices/:id', ah(async (req, res) => {
  const invoice = oid(req.params.id) && (await Invoice.findById(req.params.id).lean());
  if (!invoice) throw notFound('Bill');
  res.json(await invoiceDocument(invoice));
}));

adminRouter.patch('/invoices/:id', ah(async (req, res) => {
  const body = parse(z.object({
    amount: money.optional(),
    discount: money.optional(),
    dueDate: dateStr.optional(),
    description: z.string().max(200).optional(),
    notes: z.string().max(500).optional(),
    status: z.enum(['waived', 'cancelled', 'open']).optional(),
  }), req.body);
  const invoice = oid(req.params.id) && (await Invoice.findById(req.params.id));
  if (!invoice) throw notFound('Bill');
  if (body.amount != null) invoice.amount = body.amount;
  if (body.discount != null) invoice.discount = Math.min(body.discount, invoice.amount);
  invoice.total = round(invoice.amount - invoice.discount);
  if (body.dueDate) invoice.dueDate = new Date(body.dueDate);
  if (body.description != null) invoice.description = body.description;
  if (body.notes != null) invoice.notes = body.notes;
  if (body.status === 'waived' || body.status === 'cancelled') {
    if (body.status === 'cancelled' && invoice.paid > 0) throw badRequest('This bill has payments. Waive it instead, or delete the payments first.');
    invoice.status = body.status;
  } else if (body.status === 'open') {
    invoice.status = 'pending';
  }
  await recalcInvoice(invoice);
  await refreshAccount(invoice.business);
  await log(req.user._id, invoice.business, 'invoice.updated', { number: invoice.number, ...body });
  res.json({ invoice });
}));

adminRouter.delete('/invoices/:id', ah(async (req, res) => {
  const invoice = oid(req.params.id) && (await Invoice.findById(req.params.id));
  if (!invoice) throw notFound('Bill');
  if (await Payment.exists({ 'allocations.invoice': invoice._id, status: 'confirmed' })) throw badRequest('This bill has payments. Delete the payments first, or waive the bill.');
  await invoice.deleteOne();
  await refreshAccount(invoice.business);
  await log(req.user._id, invoice.business, 'invoice.deleted', { number: invoice.number });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------- payments */

adminRouter.post('/accounts/:id/payments', ah(async (req, res) => {
  const body = parse(z.object({
    amount: z.number().positive('Enter the amount received').max(10_000_000),
    method: z.enum(PAYMENT_METHODS).default('upi'),
    reference: z.string().trim().max(120).optional().default(''),
    paidAt: dateStr.optional(),
    notes: z.string().max(500).optional().default(''),
    invoiceId: z.string().optional(),
  }), req.body);
  const b = await loadBusiness(req.params.id);
  const payment = await Payment.create({
    business: b._id, amount: body.amount, method: body.method, reference: body.reference, notes: body.notes,
    paidAt: body.paidAt ? new Date(body.paidAt) : new Date(), status: 'confirmed', submittedBy: 'admin',
    recordedBy: req.user._id, verifiedAt: new Date(), preferredInvoice: oid(body.invoiceId) || undefined,
  });
  await allocatePayment(payment);
  await refreshAccount(b);
  await log(req.user._id, b._id, 'payment.recorded', { amount: body.amount, method: body.method, reference: body.reference });
  res.status(201).json({ payment, billing: await billingSummary(b) });
}));

adminRouter.get('/payments', ah(async (req, res) => {
  const filter = {};
  if (['confirmed', 'pending', 'rejected'].includes(String(req.query.status))) filter.status = req.query.status;
  if (req.query.method && PAYMENT_METHODS.includes(String(req.query.method))) filter.method = req.query.method;
  const payments = await Payment.find(filter).sort({ paidAt: -1 }).limit(300).populate('business', 'name').populate('recordedBy', 'name').populate('allocations.invoice', 'number').lean();
  res.json({ payments });
}));

adminRouter.post('/payments/:id/confirm', ah(async (req, res) => {
  const body = parse(z.object({ amount: z.number().positive().optional(), invoiceId: z.string().optional() }), req.body || {});
  const payment = oid(req.params.id) && (await Payment.findById(req.params.id));
  if (!payment) throw notFound('Payment');
  if (payment.status === 'confirmed') return res.json({ payment });
  if (body.amount) payment.amount = body.amount; // the amount actually received
  if (body.invoiceId && oid(body.invoiceId)) payment.preferredInvoice = oid(body.invoiceId);
  payment.status = 'confirmed';
  payment.verifiedAt = new Date();
  payment.recordedBy = req.user._id;
  await payment.save();
  await allocatePayment(payment);
  await refreshAccount(payment.business);
  await log(req.user._id, payment.business, 'payment.confirmed', { amount: payment.amount, reference: payment.reference });
  res.json({ payment });
}));

adminRouter.post('/payments/:id/reject', ah(async (req, res) => {
  const body = parse(z.object({ reason: z.string().max(300).optional().default('') }), req.body || {});
  const payment = oid(req.params.id) && (await Payment.findById(req.params.id));
  if (!payment) throw notFound('Payment');
  if (payment.status === 'confirmed') throw badRequest('This payment is already confirmed. Delete it instead.');
  payment.status = 'rejected';
  payment.notes = [payment.notes, body.reason && `Rejected: ${body.reason}`].filter(Boolean).join('\n');
  await payment.save();
  await log(req.user._id, payment.business, 'payment.rejected', { amount: payment.amount, reference: payment.reference, reason: body.reason });
  res.json({ payment });
}));

/** Removes a payment (e.g. entered by mistake); the bills it paid open up again. */
adminRouter.delete('/payments/:id', ah(async (req, res) => {
  const payment = oid(req.params.id) && (await Payment.findById(req.params.id));
  if (!payment) throw notFound('Payment');
  const invoiceIds = (payment.allocations || []).map((a) => a.invoice);
  await payment.deleteOne();
  for (const id of invoiceIds) {
    const inv = await Invoice.findById(id);
    if (inv) await recalcInvoice(inv);
  }
  await refreshAccount(payment.business);
  await log(req.user._id, payment.business, 'payment.deleted', { amount: payment.amount, reference: payment.reference });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ plans */

const planSchema = z.object({
  name: z.string().trim().min(2, 'Name the plan').max(60),
  description: z.string().max(300).optional().default(''),
  price: z.number().min(0).max(10_000_000),
  billingCycle: z.enum(CYCLES).default('monthly'),
  features: z.array(z.string().trim().max(120)).max(20).optional().default([]),
  active: z.boolean().optional().default(true),
  sortOrder: z.number().int().optional().default(0),
});

adminRouter.get('/plans', ah(async (_req, res) => {
  const plans = await Plan.find().sort({ sortOrder: 1, price: 1 }).lean();
  const counts = await Business.aggregate([{ $group: { _id: '$account.plan', n: { $sum: 1 } } }]);
  res.json({ plans: plans.map((p) => ({ ...p, accounts: counts.find((c) => String(c._id) === String(p._id))?.n || 0 })) });
}));
adminRouter.post('/plans', ah(async (req, res) => {
  const plan = await Plan.create(parse(planSchema, req.body));
  await log(req.user._id, null, 'plan.created', { name: plan.name, price: plan.price });
  res.status(201).json({ plan });
}));
adminRouter.patch('/plans/:id', ah(async (req, res) => {
  const body = parse(planSchema.partial(), req.body);
  const plan = oid(req.params.id) && (await Plan.findByIdAndUpdate(req.params.id, body, { new: true }));
  if (!plan) throw notFound('Plan');
  await log(req.user._id, null, 'plan.updated', { name: plan.name, ...body });
  res.json({ plan });
}));
adminRouter.delete('/plans/:id', ah(async (req, res) => {
  if (await Business.exists({ 'account.plan': req.params.id })) throw badRequest('Accounts are on this plan. Move them first, or turn the plan off instead.');
  await Plan.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

/* ------------------------------------------------------- settings + admins */

const settingsSchema = z.object({
  companyName: z.string().trim().max(80),
  upiId: z.string().trim().max(80),
  bankDetails: z.string().max(600),
  paymentInstructions: z.string().max(600),
  supportPhone: z.string().trim().max(30),
  supportEmail: z.union([z.literal(''), z.string().trim().email()]),
  defaultTrialDays: z.number().int().min(0).max(365),
  invoiceDueDays: z.number().int().min(0).max(90),
  autoSuspendOverdueDays: z.number().int().min(0).max(365),
}).partial();

adminRouter.get('/settings', ah(async (_req, res) => {
  const admins = await User.find({ $or: [{ role: 'admin' }, { email: { $in: env.adminEmails } }] }).select('name email role lastLoginAt').lean();
  res.json({
    settings: await Setting.get(),
    admins: admins.map((a) => ({ id: a._id, name: a.name, email: a.email, fromEnv: env.adminEmails.includes(a.email), lastLoginAt: a.lastLoginAt })),
    envAdmins: env.adminEmails,
  });
}));

adminRouter.patch('/settings', ah(async (req, res) => {
  const body = parse(settingsSchema, req.body);
  const s = await Setting.get();
  s.set(body);
  await s.save();
  await log(req.user._id, null, 'settings.updated', body);
  res.json({ settings: s });
}));

/** Give an existing user admin access, or create a new admin login (name + password). */
adminRouter.post('/admins', ah(async (req, res) => {
  const body = parse(z.object({
    email: z.string().trim().email('Enter a valid email'),
    name: z.string().trim().max(80).optional(),
    password: z.string().min(8, 'Use at least 8 characters').max(200).optional(),
  }), req.body);
  let user = await User.findOne({ email: body.email.toLowerCase() });
  let created = false;
  if (!user) {
    if (!body.password) throw badRequest('No account with this email yet. Add a name and password to create their admin login.');
    user = new User({ email: body.email, name: body.name || body.email.split('@')[0], role: 'admin' });
    await user.setPassword(body.password);
    created = true;
  }
  user.role = 'admin';
  await user.save();
  await log(req.user._id, null, 'admin.added', { email: user.email, created });
  res.status(201).json({ ok: true, created });
}));

adminRouter.delete('/admins/:id', ah(async (req, res) => {
  const user = oid(req.params.id) && (await User.findById(req.params.id));
  if (!user) throw notFound('User');
  if (String(user._id) === String(req.user._id)) throw badRequest('You can’t remove yourself');
  if (env.adminEmails.includes(user.email)) throw badRequest('This admin is set in ADMIN_EMAILS on the server. Remove it there.');
  user.role = 'owner';
  await user.save();
  await log(req.user._id, null, 'admin.removed', { email: user.email });
  res.json({ ok: true });
}));

/** Everything admins did, newest first. */
adminRouter.get('/activity', ah(async (_req, res) => {
  const logs = await AdminLog.find().sort({ createdAt: -1 }).limit(200).populate('admin', 'name').populate('business', 'name').lean();
  res.json({ logs });
}));

