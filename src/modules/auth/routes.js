import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User, Business } from '../../models/index.js';
import { requireAuth, signToken } from '../../middleware/auth.js';
import { ah, parse, conflict, unauthorized } from '../../utils/http.js';

export const authRouter = Router();

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

const signupSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(80),
  email: z.string().trim().email('Enter a valid email'),
  password: z.string().min(8, 'Use at least 8 characters').max(200),
  businessName: z.string().trim().min(2, 'Enter your business name').max(120),
  category: z.string().trim().max(60).optional(),
});

authRouter.post(
  '/signup',
  limiter,
  ah(async (req, res) => {
    const body = parse(signupSchema, req.body);
    const exists = await User.findOne({ email: body.email.toLowerCase() });
    if (exists) throw conflict('An account with this email already exists. Sign in instead.');
    const user = new User({ name: body.name, email: body.email });
    await user.setPassword(body.password);
    await user.save();
    const business = await Business.create({ owner: user._id, name: body.businessName, category: body.category || 'Salon' });
    await business.ensureSlug();
    res.status(201).json({ token: signToken(user), user, business });
  })
);

authRouter.post(
  '/login',
  limiter,
  ah(async (req, res) => {
    const body = parse(z.object({ email: z.string().trim().email(), password: z.string().min(1) }), req.body);
    const user = await User.findOne({ email: body.email.toLowerCase() }).select('+passwordHash');
    if (!user || !(await user.checkPassword(body.password))) throw unauthorized('Email or password is incorrect');
    user.lastLoginAt = new Date();
    await user.save();
    const business = await Business.findOne({ owner: user._id });
    res.json({ token: signToken(user), user, business });
  })
);

authRouter.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const business = await Business.findOne({ owner: req.user._id });
    res.json({ user: req.user, business });
  })
);

authRouter.patch(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(80).optional(),
        currentPassword: z.string().optional(),
        newPassword: z.string().min(8, 'Use at least 8 characters').optional(),
      }),
      req.body
    );
    const user = await User.findById(req.user._id).select('+passwordHash');
    if (body.name) user.name = body.name;
    if (body.newPassword) {
      if (!body.currentPassword || !(await user.checkPassword(body.currentPassword))) throw unauthorized('Current password is incorrect');
      await user.setPassword(body.newPassword);
    }
    await user.save();
    res.json({ user });
  })
);
