import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse, notFound } from '../../utils/http.js';
import { Service } from '../../models/index.js';
import { env, groqConfigured } from '../../config/env.js';
import { generateContent, suggestTopics } from './service.js';

export const aiRouter = Router();
aiRouter.use(requireAuth, requireBusiness);
aiRouter.use(rateLimit({ windowMs: 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => String(req.business?._id || req.ip) }));

aiRouter.get('/status', (req, res) => {
  res.json({ provider: 'groq', configured: groqConfigured(), model: env.groq.model, fastModel: env.groq.fastModel });
});

/** AI content assistant: generates text for the owner to review. Nothing is saved or published here. */
aiRouter.post('/content', ah(async (req, res) => {
  const body = parse(
    z.object({
      kind: z.enum(['description', 'service', 'caption', 'faq', 'promo']),
      serviceId: z.string().optional(),
      instruction: z.string().max(400).optional(),
    }),
    req.body
  );
  const services = await Service.find({ business: req.business._id, active: true }).lean();
  let target;
  if (body.kind === 'service') {
    target = services.find((s) => String(s._id) === body.serviceId);
    if (!target) throw notFound('Service');
  }
  const result = await generateContent({ kind: body.kind, business: req.business, services, target, instruction: body.instruction });
  res.json(result);
}));

aiRouter.post('/topics', ah(async (req, res) => {
  const body = parse(z.object({ serviceName: z.string().max(140) }), req.body);
  res.json({ topics: await suggestTopics({ serviceName: body.serviceName, business: req.business }) });
}));
