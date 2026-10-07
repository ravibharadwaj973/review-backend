import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse } from '../../utils/http.js';
import { AiResponse, Review, Photo, Post, Question, GoogleAccount } from '../../models/index.js';
import { applyReplyRule, draftBacklog, publishDueReplies, replyRuleFor } from '../reviews/service.js';
import { planPhotos, postedInWeek } from '../photos/schedule.js';
import { planPosts } from '../posts/service.js';
import { activeSeason, holidayPlan } from '../hours/service.js';
import { runAutopilotFor } from './runner.js';
import { addDaysYmd, localYmd, safeTz, weekStartYmd, zonedDate } from '../../utils/time.js';

export const autopilotRouter = Router();
autopilotRouter.use(requireAuth, requireBusiness);

const rule = z.enum(['auto', 'approve']);
const settingsSchema = z.object({
  replyRules: z.object({ five: rule, four: rule, three: rule, low: rule }).partial().optional(),
  replyDelayMinutes: z.number().int().min(0).max(1440).optional(),
  autoDraftReplies: z.boolean().optional(),
  syncHoursToGoogle: z.boolean().optional(),
  photos: z.object({ enabled: z.boolean(), perWeek: z.number().int().min(0).max(7), autoQueueUploads: z.boolean() }).partial().optional(),
  posts: z.object({
    enabled: z.boolean(),
    perWeek: z.number().int().min(0).max(3),
    autoPublish: z.boolean(),
    day: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
    time: z.string().regex(/^\d{2}:\d{2}$/),
  }).partial().optional(),
});

const plain = (v) => (v?.toObject ? v.toObject() : v || {});

function settingsOf(b) {
  const a = plain(b.automation);
  return {
    replyRules: { five: 'auto', four: 'auto', three: 'approve', low: 'approve', ...plain(a.replyRules) },
    replyDelayMinutes: a.replyDelayMinutes ?? 30,
    autoDraftReplies: a.autoDraftReplies !== false,
    syncHoursToGoogle: a.syncHoursToGoogle !== false,
    photos: { enabled: true, perWeek: 4, autoQueueUploads: true, ...plain(b.autopilot?.photos) },
    posts: { enabled: true, perWeek: 1, autoPublish: false, day: 'tuesday', time: '11:00', ...plain(b.autopilot?.posts) },
  };
}

/** Everything the Autopilot page shows: settings, counts and the next 7 days. */
autopilotRouter.get('/', ah(async (req, res) => {
  const b = req.business;
  const tz = safeTz(b.timezone);
  const now = new Date();
  const weekStart = weekStartYmd(now, tz);
  const today = localYmd(now, tz);
  const in7 = zonedDate(addDaysYmd(today, 7), '00:00', tz);
  const startToday = zonedDate(today, '00:00', tz);
  const weekFrom = zonedDate(weekStart, '00:00', tz);

  const [account, autoDrafts, approvalDrafts, backlog, repliedThisWeek, queued, postedPhotos, upcomingPhotos, postDrafts, postScheduled, postsThisWeek, upcomingPosts, qAnswered, qSuggested] = await Promise.all([
    GoogleAccount.findOne({ business: b._id }).select('mode status locationName locationTitle').lean(),
    AiResponse.find({ business: b._id, status: 'draft', autoPublishAt: { $exists: true } }).sort({ autoPublishAt: 1 }).limit(5).populate('review', 'reviewer rating comment').lean(),
    AiResponse.countDocuments({ business: b._id, status: 'draft', autoPublishAt: { $exists: false } }),
    Review.countDocuments({ business: b._id, status: 'unanswered' }),
    AiResponse.countDocuments({ business: b._id, status: 'published', publishedAt: { $gte: weekFrom } }),
    Photo.countDocuments({ business: b._id, queued: true }),
    postedInWeek(b._id, weekStart, tz),
    Photo.find({ business: b._id, queued: true, scheduledFor: { $gte: startToday, $lt: in7 } }).sort({ scheduledFor: 1 }).select('fileUrl scheduledFor caption category').lean(),
    Post.countDocuments({ business: b._id, status: 'draft' }),
    Post.countDocuments({ business: b._id, status: 'scheduled' }),
    Post.countDocuments({ business: b._id, status: 'published', publishedAt: { $gte: weekFrom } }),
    Post.find({ business: b._id, status: { $in: ['draft', 'scheduled', 'published'] }, $or: [{ scheduledFor: { $gte: startToday, $lt: in7 } }, { publishedAt: { $gte: startToday, $lt: in7 } }] }).select('summary status scheduledFor publishedAt theme').lean(),
    Question.countDocuments({ business: b._id, status: 'answered' }),
    Question.countDocuments({ business: b._id, status: 'suggested' }),
  ]);
  const autoCount = await AiResponse.countDocuments({ business: b._id, status: 'draft', autoPublishAt: { $exists: true } });

  const holidays = holidayPlan(b, { days: 60 });
  const days = Array.from({ length: 7 }, (_, i) => {
    const ymd = addDaysYmd(today, i);
    const sameDay = (d) => d && localYmd(new Date(d), tz) === ymd;
    return {
      date: ymd,
      photos: upcomingPhotos.filter((p) => sameDay(p.scheduledFor)),
      posts: upcomingPosts.filter((p) => sameDay(p.status === 'published' ? p.publishedAt : p.scheduledFor)),
      holiday: holidays.find((h) => h.date === ymd) || null,
    };
  });
  const season = activeSeason(b);

  res.json({
    settings: settingsOf(b),
    connection: account ? { mode: account.mode, ready: account.mode === 'demo' || Boolean(account.locationName), title: account.locationTitle } : null,
    replies: { auto: autoCount, nextAuto: autoDrafts, waitingApproval: approvalDrafts, backlog, repliedThisWeek },
    photos: { queued, postedThisWeek: postedPhotos },
    posts: { drafts: postDrafts, scheduled: postScheduled, publishedThisWeek: postsThisWeek },
    hours: {
      season: season ? { name: season.name, start: season.start, end: season.end } : null,
      upcoming: holidays.filter((h) => h.daysAway <= 45).slice(0, 4),
      unset: holidays.filter((h) => !h.set && h.daysAway <= 21),
    },
    questions: { answered: qAnswered, suggested: qSuggested },
    week: days,
  });
}));

autopilotRouter.patch('/', ah(async (req, res) => {
  const body = parse(settingsSchema, req.body);
  const b = req.business;
  const automation = plain(b.automation);
  if (body.replyRules) automation.replyRules = { ...plain(automation.replyRules), ...body.replyRules };
  for (const k of ['replyDelayMinutes', 'autoDraftReplies', 'syncHoursToGoogle']) if (k in body) automation[k] = body[k];
  b.set('automation', automation);
  const ap = plain(b.autopilot);
  if (body.photos) ap.photos = { ...plain(ap.photos), ...body.photos };
  if (body.posts) ap.posts = { ...plain(ap.posts), ...body.posts };
  b.set('autopilot', ap);
  await b.save();

  if (body.photos) await planPhotos(b);
  // Rules changed: line up / cancel automatic posting of replies already drafted
  if (body.replyRules || 'replyDelayMinutes' in body) await reapplyReplyRules(b);
  // Writing new post drafts calls the AI, so it happens after the response
  if (body.posts) planPosts(b).catch((err) => console.warn('[autopilot] plan posts:', err.message));
  res.json({ settings: settingsOf(b), business: b });
}));

async function reapplyReplyRules(business) {
  const drafts = await AiResponse.find({ business: business._id, status: 'draft' }).populate('review');
  let i = 0;
  for (const d of drafts) {
    if (!d.review || d.review.status === 'answered') continue;
    const decision = replyRuleFor(business, d.review);
    if (decision.rule === 'approve' && d.autoPublishAt) {
      d.autoPublishAt = undefined;
      await d.save();
    } else if (decision.rule === 'auto' && !d.autoPublishAt) {
      await applyReplyRule(d, d.review, business, { extraDelayMinutes: i * 3 });
      i += 1;
    }
  }
}

/** Draft replies for older reviews with no reply; reply rules decide which post by themselves. */
autopilotRouter.post('/replies/backlog', ah(async (req, res) => {
  const count = await Review.countDocuments({ business: req.business._id, status: { $in: ['unanswered', 'drafted'] } });
  draftBacklog(req.business, { limit: 30 }).catch((err) => console.warn('[autopilot] backlog:', err.message));
  res.status(202).json({ started: true, reviews: Math.min(count, 30) });
}));

/** Run the autopilot for this business right now (also posts anything that is due). */
autopilotRouter.post('/run', ah(async (req, res) => {
  const replies = await publishDueReplies({ businessId: req.business._id });
  const result = await runAutopilotFor(req.business);
  res.json({ replies, ...result });
}));
