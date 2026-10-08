import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { env, googleConfigured, groqConfigured, isAllowedOrigin } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter } from './modules/auth/routes.js';
import { businessRouter } from './modules/business/routes.js';
import { servicesRouter } from './modules/services/routes.js';
import { customersRouter } from './modules/customers/routes.js';
import { photosRouter } from './modules/photos/routes.js';
import { googleRouter, googleAuthRouter } from './modules/google/routes.js';
import { reviewsRouter } from './modules/reviews/routes.js';
import { requestsRouter } from './modules/requests/routes.js';
import { aiRouter } from './modules/ai/routes.js';
import { analyticsRouter } from './modules/analytics/routes.js';
import { publicRouter } from './modules/public/routes.js';
import { postsRouter } from './modules/posts/routes.js';
import { questionsRouter } from './modules/questions/routes.js';
import { autopilotRouter } from './modules/autopilot/routes.js';
import { adminRouter } from './modules/admin/routes.js';
import { billingRouter } from './modules/billing/routes.js';

export function createApp() {
  const app = express();
  // Number of proxies in front of the API, so rate limits see the real visitor IP.
  // 1 = nginx only. 2 = Vercel rewrites + nginx (the AWS + Vercel setup).
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      // Only the website(s) in FRONTEND_URL may call the API from a browser.
      origin(origin, cb) {
        cb(null, isAllowedOrigin(origin));
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: '2mb' }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan(env.isProd ? 'combined' : 'dev'));

  app.use('/uploads', express.static(path.resolve(env.uploadDir), { maxAge: '7d', fallthrough: false }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      ai: groqConfigured() ? 'groq' : 'fallback',
      google: googleConfigured() ? 'configured' : 'not_configured',
      frontend: env.appUrl,
      admin: env.adminUrl || null,
      time: new Date().toISOString(),
    });
  });

  // Connect Google: GET /api/auth/google (start) and GET /api/auth/google/callback (Google returns here)
  app.use('/api/auth/google', googleAuthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/business', businessRouter);
  app.use('/api/services', servicesRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/photos', photosRouter);
  app.use('/api/google', googleRouter);
  app.use('/api/reviews', reviewsRouter);
  app.use('/api/requests', requestsRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/posts', postsRouter);
  app.use('/api/questions', questionsRouter);
  app.use('/api/autopilot', autopilotRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/admin', adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
