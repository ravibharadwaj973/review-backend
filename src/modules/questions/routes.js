import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse, notFound } from '../../utils/http.js';
import { Question, Service, Review, Post } from '../../models/index.js';
import { answerQuestion, suggestQuestions } from '../ai/service.js';
import { answeredFaqs } from '../reviews/service.js';
import { draftPostFor } from '../posts/service.js';

export const questionsRouter = Router();
questionsRouter.use(requireAuth, requireBusiness);

async function owned(req) {
  const q = await Question.findOne({ _id: req.params.id, business: req.business._id });
  if (!q) throw notFound('Question');
  return q;
}

questionsRouter.get('/', ah(async (req, res) => {
  const questions = await Question.find({ business: req.business._id, status: { $ne: 'dismissed' } }).sort({ status: 1, createdAt: -1 }).populate('post', 'status publishedAt').lean();
  const answered = questions.filter((q) => q.status === 'answered').length;
  res.json({ questions, counts: { answered, suggested: questions.length - answered } });
}));

/** AI suggests the questions customers usually ask, using services and recent reviews. */
questionsRouter.post('/suggest', ah(async (req, res) => {
  const [services, faqs, reviews, existing] = await Promise.all([
    Service.find({ business: req.business._id, active: true }).lean(),
    answeredFaqs(req.business._id),
    Review.find({ business: req.business._id, comment: { $ne: '' } }).sort({ createTime: -1 }).limit(25).select('comment rating').lean(),
    Question.find({ business: req.business._id }).select('question').lean(),
  ]);
  const { questions, model } = await suggestQuestions({
    business: req.business, services, faqs,
    reviewSnippets: reviews.map((r) => `(${r.rating}★) ${r.comment.slice(0, 200)}`),
    existing: existing.map((q) => q.question),
  });
  const created = await Question.insertMany(questions.map((q) => ({
    business: req.business._id,
    question: q.question,
    answer: q.answer,
    needsInput: q.needsInput,
    aiDrafted: Boolean(q.answer),
    source: q.fromReviews ? 'reviews' : 'ai',
    status: 'suggested',
  })));
  res.status(201).json({ created: created.length, model });
}));

questionsRouter.post('/', ah(async (req, res) => {
  const body = parse(z.object({ question: z.string().trim().min(3, 'Write the question').max(300), answer: z.string().trim().max(1500).optional().default('') }), req.body);
  const q = await Question.create({ ...body, business: req.business._id, source: 'manual', status: body.answer ? 'answered' : 'suggested', needsInput: !body.answer });
  res.status(201).json({ question: q });
}));

questionsRouter.patch('/:id', ah(async (req, res) => {
  const body = parse(z.object({
    question: z.string().trim().min(3).max(300).optional(),
    answer: z.string().trim().max(1500).optional(),
    status: z.enum(['suggested', 'answered', 'dismissed']).optional(),
  }), req.body);
  const q = await owned(req);
  q.set(body);
  if (body.answer !== undefined) {
    q.needsInput = !body.answer;
    if (body.answer && !body.status) q.status = 'answered';
  }
  if (q.status === 'answered' && !q.answer) q.status = 'suggested';
  await q.save();
  res.json({ question: q });
}));

/** AI drafts an answer from the profile (not saved until the owner saves it). */
questionsRouter.post('/:id/draft-answer', ah(async (req, res) => {
  const q = await owned(req);
  const [services, faqs] = await Promise.all([Service.find({ business: req.business._id, active: true }).lean(), answeredFaqs(req.business._id)]);
  res.json(await answerQuestion({ business: req.business, services, faqs: faqs.filter((f) => String(f._id) !== String(q._id)), question: q.question }));
}));

/** Turns an answered question into a Google post draft. */
questionsRouter.post('/:id/share', ah(async (req, res) => {
  const q = await owned(req);
  if (!q.answer) throw Object.assign(new Error('Answer the question first'), { status: 400 });
  const [services, faqs] = await Promise.all([Service.find({ business: req.business._id, active: true }).lean(), answeredFaqs(req.business._id)]);
  const post = await draftPostFor(req.business, { theme: 'faq', featured: q, featuredKey: q.question, services, faqs });
  post.status = 'draft';
  await post.save();
  q.post = post._id;
  await q.save();
  res.status(201).json({ post });
}));

questionsRouter.delete('/:id', ah(async (req, res) => {
  const q = await owned(req);
  if (q.post) await Post.updateOne({ _id: q.post, status: 'draft' }, { status: 'discarded' });
  await q.deleteOne();
  res.json({ ok: true });
}));
