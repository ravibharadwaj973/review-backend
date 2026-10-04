import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse, notFound } from '../../utils/http.js';
import { Service } from '../../models/index.js';
import { suggestTopics, discoverServices } from '../ai/service.js';
import { badRequest, HttpError } from '../../utils/http.js';
import { GoogleAccount } from '../../models/index.js';
import * as google from '../google/client.js';
import { fetchWebsiteText } from './website.js';

export const servicesRouter = Router();
servicesRouter.use(requireAuth, requireBusiness);

const serviceSchema = z.object({
  name: z.string().trim().min(1, 'Name the service').max(140),
  description: z.string().max(300).optional(),
  category: z.string().trim().max(60).optional(),
  price: z.number().min(0).nullable().optional(),
  duration: z.number().min(0).max(1440).nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().optional(),
  reviewTopics: z.array(z.string().trim().max(60)).max(8).optional(),
});

servicesRouter.get('/', ah(async (req, res) => {
  const services = await Service.find({ business: req.business._id }).sort({ category: 1, sortOrder: 1, name: 1 });
  res.json({ services });
}));

servicesRouter.post('/', ah(async (req, res) => {
  const body = parse(serviceSchema, req.body);
  const service = await Service.create({ ...body, business: req.business._id });
  if (!req.business.onboarding.services) {
    req.business.onboarding.services = true;
    await req.business.save();
  }
  res.status(201).json({ service });
}));

/**
 * Finds services the business offers so the owner can add them in one go. Nothing is saved here.
 * source: ai (from business type) | website (reads their site) | google (reads their Google profile)
 */
servicesRouter.post('/discover', ah(async (req, res) => {
  const body = parse(z.object({ source: z.enum(['ai', 'website', 'google']).default('ai'), url: z.string().url().optional() }), req.body || {});
  const existing = await Service.find({ business: req.business._id }).select('name').lean();

  if (body.source === 'website') {
    const url = body.url || req.business.links?.website;
    if (!url) throw badRequest('Add your website address first (Business profile → Website & links), or paste it here.');
    const text = await fetchWebsiteText(url);
    if (text.length < 80) throw badRequest('We couldn’t read any text from that website. It may be built with images only or block bots.');
    try {
      return res.json(await discoverServices({ business: req.business, existing, source: 'website', websiteText: text }));
    } catch (err) {
      throw new HttpError(503, 'Reading services from a website needs the Groq AI key. Add GROQ_API_KEY and try again.');
    }
  }

  if (body.source === 'google') {
    const account = await GoogleAccount.findOne({ business: req.business._id }).select('+accessTokenEnc +refreshTokenEnc');
    if (!account || account.mode !== 'live' || !account.locationName) throw badRequest('Connect your real Google Business Profile first.');
    const loc = await google.getLocation(account, account.locationName);
    const seen = new Set(existing.map((e) => e.name.toLowerCase()));
    const services = (loc.serviceItems || [])
      .map((it) => {
        const label = it.freeFormServiceItem?.label || {};
        const name = label.displayName || it.structuredServiceItem?.serviceTypeId?.split(':').pop()?.replace(/_/g, ' ') || '';
        return { name: name.charAt(0).toUpperCase() + name.slice(1), category: 'From Google', description: label.description || it.structuredServiceItem?.description || '', price: it.price?.units ? Number(it.price.units) : null, duration: null };
      })
      .filter((s) => s.name && !seen.has(s.name.toLowerCase()));
    return res.json({ services, model: 'google', source: 'google' });
  }

  res.json(await discoverServices({ business: req.business, existing, source: 'ai' }));
}));

/** Bulk create, used by onboarding and service discovery. */
servicesRouter.post('/bulk', ah(async (req, res) => {
  const body = parse(z.object({ services: z.array(serviceSchema).min(1).max(100) }), req.body);
  const services = await Service.insertMany(body.services.map((s, i) => ({ ...s, sortOrder: i, business: req.business._id })));
  req.business.onboarding.services = true;
  await req.business.save();
  res.status(201).json({ services });
}));

servicesRouter.patch('/:id', ah(async (req, res) => {
  const body = parse(serviceSchema.partial(), req.body);
  const service = await Service.findOneAndUpdate(
    { _id: req.params.id, business: req.business._id },
    { ...body, 'google.syncStatus': 'not_synced' },
    { new: true, runValidators: true }
  );
  if (!service) throw notFound('Service');
  res.json({ service });
}));

servicesRouter.delete('/:id', ah(async (req, res) => {
  const result = await Service.deleteOne({ _id: req.params.id, business: req.business._id });
  if (!result.deletedCount) throw notFound('Service');
  res.json({ ok: true });
}));

servicesRouter.post('/:id/topics', ah(async (req, res) => {
  const service = await Service.findOne({ _id: req.params.id, business: req.business._id });
  if (!service) throw notFound('Service');
  service.reviewTopics = await suggestTopics({ serviceName: service.name, business: req.business });
  await service.save();
  res.json({ service });
}));
