import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse, notFound, badRequest } from '../../utils/http.js';
import { GoogleAccount, CompletedActivity } from '../../models/index.js';
import { isLiveConnection } from '../reviews/policy.js';
import { searchKeywordMonth, getSearchKeywords } from '../google/client.js';
import { addDaysYmd, localYmd, safeTz, zonedDate } from '../../utils/time.js';
import { performanceAccount, fetchSnapshot, comparePeriods, completedActivities, activityWindows, validDay } from './service.js';

export const performanceRouter = Router();
performanceRouter.use(requireAuth, requireBusiness);
performanceRouter.use(rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));
performanceRouter.get('/', ah(async (req, res) => {
  const { days, refresh } = parse(z.object({ days: z.enum(['30', '90']).default('30'), refresh: z.enum(['0', '1']).default('0') }), req.query);
  const account = await GoogleAccount.findOne({ business: req.business._id }).lean();
  if (!isLiveConnection(account)) return res.json({ connected: false, snapshot: null, activities: [], comparison: [], keywords: null });
  const live = await performanceAccount(req.business);
  const end = addDaysYmd(localYmd(new Date(), safeTz(req.business.timezone)), -1);
  const current = { start: addDaysYmd(end, 1 - Number(days)), end };
  const previous = { start: addDaysYmd(current.start, -Number(days)), end: addDaysYmd(current.start, -1) };
  const month = searchKeywordMonth();
  const [snapshot, activities, terms] = await Promise.all([
    fetchSnapshot(req.business, live, previous.start, end, refresh === '1'),
    completedActivities(req.business, live),
    getSearchKeywords(live, month).then((items) => ({ month: `${month.year}-${String(month.month).padStart(2, '0')}`, items })).catch((err) => ({ month: null, items: [], error: err.message })),
  ]);
  res.json({ connected: true, locationName: live.locationName, title: live.locationTitle, snapshot, current, previous, comparison: comparePeriods(snapshot.series, previous, current), activities, keywords: terms });
}));
performanceRouter.post('/activities', ah(async (req, res) => {
  const body = parse(z.object({ title: z.string().trim().min(3).max(160), kind: z.enum(['website', 'directory', 'community', 'other']), completedDate: z.string().refine(validDay, 'Use a real completion date') }), req.body);
  const tz = safeTz(req.business.timezone);
  if (body.completedDate > localYmd(new Date(), tz)) throw badRequest('Completed activities cannot have a future date');
  const account = await performanceAccount(req.business);
  const activity = await CompletedActivity.create({ title: body.title, kind: body.kind, completedAt: zonedDate(body.completedDate, '00:00', tz), business: req.business._id, locationName: account.locationName, recordedBy: req.user._id, source: 'owner' });
  res.status(201).json({ activity });
}));
performanceRouter.get('/compare', ah(async (req, res) => {
  const { id, days } = parse(z.object({ id: z.string().max(80), days: z.enum(['7', '14', '28']).default('14') }), req.query);
  const account = await performanceAccount(req.business);
  const activities = await completedActivities(req.business, account);
  const activity = activities.find((a) => a.id === id);
  if (!activity) throw notFound('Completed activity');
  const windows = activityWindows(activity.completedAt, req.business, Number(days));
  if (!validDay(windows.before.start)) throw badRequest('Invalid activity date');
  const end = windows.after.end > windows.lastDay ? windows.lastDay : windows.after.end;
  if (end < windows.before.start) throw badRequest('No completed days are available around this activity');
  const snapshot = await fetchSnapshot(req.business, account, windows.before.start, end);
  res.json({ activity, windows, fetchedAt: snapshot.fetchedAt, metrics: comparePeriods(snapshot.series, windows.before, windows.after) });
}));
