import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse, notFound, badRequest } from '../../utils/http.js';
import { Post, POST_TYPES, POST_ACTIONS, POST_THEMES, Photo, Service, GoogleAccount } from '../../models/index.js';
import { answeredFaqs } from '../reviews/service.js';
import { generatePost } from '../ai/service.js';
import { defaultAction, planPosts, publishPost, removeFromGoogle, validatePost } from './service.js';

export const postsRouter = Router();
postsRouter.use(requireAuth, requireBusiness);

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date');
const postSchema = z.object({
  type: z.enum(POST_TYPES).default('STANDARD'),
  summary: z.string().trim().min(1, 'Write the post text').max(1500, 'Google allows up to 1,500 characters'),
  title: z.string().trim().max(58, 'Keep the title under 58 characters').optional().default(''),
  startDate: ymd.optional().or(z.literal('')),
  endDate: ymd.optional().or(z.literal('')),
  couponCode: z.string().trim().max(58).optional().default(''),
  redeemUrl: z.union([z.literal(''), z.string().url()]).optional().default(''),
  terms: z.string().max(1000).optional().default(''),
  action: z.enum(POST_ACTIONS).default('NONE'),
  actionUrl: z.union([z.literal(''), z.string().trim().url('Enter a full link starting with https://')]).optional().default(''),
  photo: z.string().nullable().optional(),
  scheduledFor: z.string().datetime({ offset: true }).nullable().optional(),
});

async function owned(req) {
  const post = await Post.findOne({ _id: req.params.id, business: req.business._id });
  if (!post) throw notFound('Post');
  return post;
}

async function checkPhoto(req, id) {
  if (!id) return null;
  const ok = await Photo.exists({ _id: id, business: req.business._id });
  if (!ok) throw badRequest('Choose one of your photos');
  return id;
}

postsRouter.get('/', ah(async (req, res) => {
  const filter = { business: req.business._id, status: { $ne: 'discarded' } };
  if (req.query.status === 'upcoming') filter.status = { $in: ['draft', 'scheduled', 'failed'] };
  if (req.query.status === 'published') filter.status = 'published';
  const [posts, account] = await Promise.all([
    Post.find(filter).sort({ status: 1, scheduledFor: 1, publishedAt: -1, createdAt: -1 }).limit(100).populate('photo', 'fileUrl caption category').lean(),
    GoogleAccount.findOne({ business: req.business._id }).select('mode locationName').lean(),
  ]);
  const order = { failed: 0, draft: 1, scheduled: 2, published: 3 };
  posts.sort((a, b) => (order[a.status] - order[b.status]) || (a.status === 'published' ? new Date(b.publishedAt) - new Date(a.publishedAt) : new Date(a.scheduledFor || a.createdAt) - new Date(b.scheduledFor || b.createdAt)));
  res.json({ posts, connection: account ? account.mode : null, defaults: defaultAction(req.business), settings: req.business.autopilot?.posts });
}));

/** AI writes post text (not saved) */
postsRouter.post('/write', ah(async (req, res) => {
  const body = parse(z.object({
    type: z.enum(POST_TYPES).default('STANDARD'),
    theme: z.enum(POST_THEMES).default('custom'),
    instruction: z.string().max(400).optional().default(''),
    serviceId: z.string().optional(),
  }), req.body || {});
  const [services, faqs] = await Promise.all([Service.find({ business: req.business._id, active: true }).lean(), answeredFaqs(req.business._id)]);
  let featured = null;
  if (body.serviceId) featured = services.find((s) => String(s._id) === body.serviceId) || null;
  const theme = body.theme === 'custom' && featured ? 'service' : body.theme;
  const out = await generatePost({ business: req.business, services, faqs, theme, featured, type: body.type, instruction: body.instruction });
  res.json(out);
}));

postsRouter.post('/', ah(async (req, res) => {
  const body = parse(postSchema.extend({ publishNow: z.boolean().optional() }), req.body);
  const post = new Post({ ...body, photo: await checkPhoto(req, body.photo), business: req.business._id, source: 'manual' });
  if (body.scheduledFor) post.scheduledFor = new Date(body.scheduledFor);
  const problem = validatePost(post);
  if (problem) throw badRequest(problem);
  if (body.publishNow) {
    await publishPost(post, req.business);
  } else {
    post.status = post.scheduledFor ? 'scheduled' : 'draft';
    await post.save();
  }
  res.status(201).json({ post });
}));

postsRouter.patch('/:id', ah(async (req, res) => {
  const post = await owned(req);
  if (post.status === 'published') throw badRequest('This post is already on Google. Delete it and create a new one to change it.');
  const body = parse(postSchema.partial(), req.body);
  if ('photo' in body) body.photo = await checkPhoto(req, body.photo);
  if ('scheduledFor' in body) body.scheduledFor = body.scheduledFor ? new Date(body.scheduledFor) : undefined;
  post.set(body);
  if (post.status === 'failed') post.status = 'draft';
  const problem = validatePost(post);
  if (problem) throw badRequest(problem);
  await post.save();
  res.json({ post });
}));

/** Approve a draft: it posts at its planned time, or now if that time has passed. */
postsRouter.post('/:id/approve', ah(async (req, res) => {
  const post = await owned(req);
  if (post.status === 'published') return res.json({ post });
  const problem = validatePost(post);
  if (problem) throw badRequest(problem);
  if (post.scheduledFor && post.scheduledFor > new Date()) {
    post.status = 'scheduled';
    await post.save();
  } else {
    await publishPost(post, req.business);
  }
  res.json({ post });
}));

postsRouter.post('/:id/publish', ah(async (req, res) => {
  const post = await owned(req);
  if (post.status === 'published') return res.json({ post });
  await publishPost(post, req.business);
  if (post.status === 'failed') throw badRequest(`Google didn’t accept the post: ${post.error}`);
  res.json({ post });
}));

postsRouter.post('/:id/unschedule', ah(async (req, res) => {
  const post = await owned(req);
  if (post.status === 'scheduled') post.status = 'draft';
  await post.save();
  res.json({ post });
}));

postsRouter.delete('/:id', ah(async (req, res) => {
  const post = await owned(req);
  await removeFromGoogle(post, req.business);
  // Planner posts are kept as "discarded" so the same weekly slot isn't filled again
  if (post.slotKey) {
    post.status = 'discarded';
    await post.save();
  } else {
    await post.deleteOne();
  }
  res.json({ ok: true });
}));

/** Write this week's planned posts now instead of waiting for the worker. */
postsRouter.post('/plan', ah(async (req, res) => {
  const created = await planPosts(req.business);
  res.json({ created });
}));
