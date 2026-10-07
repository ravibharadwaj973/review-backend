import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse } from '../../utils/http.js';
import { Location, Business } from '../../models/index.js';
import { env } from '../../config/env.js';
import { conflict } from '../../utils/http.js';
import { GoogleAccount } from '../../models/index.js';
import { pushProfile } from '../google/sync.js';
import { holidayPlan, activeSeason } from '../hours/service.js';

export const businessRouter = Router();
businessRouter.use(requireAuth, requireBusiness);

const time = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM');
const url = z.union([z.literal(''), z.string().trim().url('Enter a full URL starting with https://')]);

const weekHours = z.array(z.object({ day: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']), open: time, close: time, closed: z.boolean() })).length(7);

const businessSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    category: z.string().trim().max(60),
    description: z.string().max(750, 'Google allows up to 750 characters'),
    phone: z.string().trim().max(30),
    email: z.union([z.literal(''), z.string().trim().email()]),
    address: z.object({
      line1: z.string().max(200).optional(),
      line2: z.string().max(200).optional(),
      city: z.string().max(80).optional(),
      state: z.string().max(80).optional(),
      postalCode: z.string().max(20).optional(),
      country: z.string().max(2).optional(),
    }),
    hours: weekHours,
    seasonalHours: z.array(z.object({
      name: z.string().trim().min(1, 'Name the season').max(60),
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a start date'),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose an end date'),
      hours: weekHours,
    }).refine((x) => x.start <= x.end, { message: 'The season must end after it starts', path: ['end'] })).max(6),
    specialHours: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), open: time.optional().or(z.literal('')), close: time.optional().or(z.literal('')), closed: z.boolean(), note: z.string().max(120).optional() })).max(60),
    serviceAreas: z.array(z.string().trim().max(80)).max(20),
    links: z.object({
      website: url.optional(), booking: url.optional(), appointment: url.optional(), ordering: url.optional(),
      whatsapp: url.optional(), instagram: url.optional(), facebook: url.optional(), youtube: url.optional(),
    }),
    policies: z.string().max(2000),
    staff: z.array(z.object({ name: z.string().trim().min(1).max(80), role: z.string().trim().max(80).optional() })).max(100),
    logoUrl: z.string().max(500),
    voice: z.object({
      tone: z.enum(['warm', 'professional', 'playful', 'concise']).optional(),
      signOff: z.string().max(80).optional(),
      language: z.string().max(40).optional(),
      avoid: z.string().max(300).optional(),
    }),
    automation: z.object({
      requestDelayHours: z.number().min(0).max(720).optional(),
      autoAnalyze: z.boolean().optional(),
      autoDraftReplies: z.boolean().optional(),
      autoPublishFiveStar: z.boolean().optional(),
      replyDelayMinutes: z.number().int().min(0).max(1440).optional(),
      syncHoursToGoogle: z.boolean().optional(),
    }),
    reviewLink: url,
  })
  .partial();

businessRouter.get('/', ah(async (req, res) => {
  const locations = await Location.find({ business: req.business._id }).lean();
  res.json({ business: req.business, locations });
}));

businessRouter.patch(
  '/',
  ah(async (req, res) => {
    const body = parse(businessSchema, req.body);
    const b = req.business;
    for (const [key, value] of Object.entries(body)) {
      if (['address', 'links', 'voice', 'automation'].includes(key)) {
        b.set(key, { ...(b.get(key)?.toObject?.() || b.get(key) || {}), ...value });
      } else {
        b.set(key, value);
      }
    }
    if (b.name && b.category && (b.phone || b.address?.city)) b.onboarding.profile = true;
    await b.save();

    // Hours changed: send them to Google straight away so customers see the right times
    let googleSync = null;
    const hoursTouched = ['hours', 'specialHours', 'seasonalHours'].some((k) => k in body);
    if (hoursTouched && b.automation?.syncHoursToGoogle !== false && (await GoogleAccount.exists({ business: b._id }))) {
      try {
        googleSync = await pushProfile(b, ['hours', 'specialHours']);
      } catch (err) {
        googleSync = { hours: { status: 'failed', message: err.message } };
      }
    }
    res.json({ business: b, googleSync });
  })
);

/** Upcoming public holidays and whether hours are set for them. */
businessRouter.get('/holidays', ah(async (req, res) => {
  const season = activeSeason(req.business);
  res.json({ holidays: holidayPlan(req.business, { days: 180 }), season: season ? { name: season.name, start: season.start, end: season.end } : null });
}));

/** The business's QR code link and its scan stats. */
businessRouter.get('/share', ah(async (req, res) => {
  const slug = await req.business.ensureSlug();
  res.json({
    slug,
    url: `${env.appUrl}/b/${slug}`,
    reviewLink: req.business.reviewLink,
    stats: { opens: 0, composed: 0, clicks: 0, submitted: 0, ...(req.business.qrStats?.toObject?.() || req.business.qrStats || {}) },
  });
}));

/** Lets the owner pick a memorable link, e.g. /b/glow-studio-noida */
businessRouter.patch('/share', ah(async (req, res) => {
  const body = parse(z.object({ slug: z.string().trim().toLowerCase().min(3, 'Use at least 3 characters').max(40).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use letters, numbers and dashes only') }), req.body);
  if (['admin', 'api', 'app', 'login', 'signup'].includes(body.slug)) throw conflict('That link is reserved. Try another.');
  const taken = await Business.exists({ slug: body.slug, _id: { $ne: req.business._id } });
  if (taken) throw conflict('That link is already taken. Try another.');
  req.business.slug = body.slug;
  await req.business.save();
  res.json({ slug: body.slug, url: `${env.appUrl}/b/${body.slug}` });
}));
