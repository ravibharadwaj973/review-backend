import { PerformanceSnapshot, CompletedActivity, Photo, Post } from '../../models/index.js';
import { loadAccount } from '../google/sync.js';
import { isLiveConnection } from '../reviews/policy.js';
import { getDailyPerformance } from '../google/client.js';
import { addDaysYmd, localYmd, safeTz } from '../../utils/time.js';
import { HttpError } from '../../utils/http.js';

export const METRICS = {
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'Search impressions / desktop',
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'Search impressions / mobile',
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'Maps impressions / desktop',
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'Maps impressions / mobile',
  WEBSITE_CLICKS: 'Website clicks', CALL_CLICKS: 'Call-button clicks', BUSINESS_DIRECTION_REQUESTS: 'Direction requests',
};
export const validDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const dayCount = (start, end) => Math.max(0, Math.round((new Date(end) - new Date(start)) / 864e5) + 1);

export function normalizePerformance(payload) {
  const result = {};
  for (const group of payload.multiDailyMetricTimeSeries || []) for (const row of group.dailyMetricTimeSeries || []) {
    if (!METRICS[row.dailyMetric] || row.dailySubEntityType && Object.keys(row.dailySubEntityType).length) continue;
    const points = new Map();
    for (const point of row.timeSeries?.datedValues || []) {
      const d = point.date;
      if (!d?.year || !d.month || !d.day) continue;
      const date = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
      // Google explicitly omits value for reported zeroes; an absent date is still unknown.
      const value = point.value === undefined ? 0 : point.value !== null && /^\d+$/.test(String(point.value)) ? Number(point.value) : NaN;
      if (validDay(date) && Number.isSafeInteger(value) && value >= 0) points.set(date, value);
    }
    result[row.dailyMetric] = [...points].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
  }
  return result;
}

export function summarizePeriod(series, start, end) {
  const days = dayCount(start, end);
  return Object.entries(METRICS).map(([metric, label]) => {
    const points = (series[metric] || []).filter((p) => p.date >= start && p.date <= end);
    return { metric, label, value: points.length ? points.reduce((sum, p) => sum + p.value, 0) : null, days: points.length, expectedDays: days, complete: days > 0 && points.length === days };
  });
}

export function comparePeriods(series, before, after) {
  const first = summarizePeriod(series, before.start, before.end);
  const second = summarizePeriod(series, after.start, after.end);
  return first.map((p, i) => ({ metric: p.metric, label: p.label, before: p, after: second[i], change: p.complete && second[i].complete && p.value > 0 ? Math.round((second[i].value - p.value) / p.value * 1000) / 10 : null }));
}

export async function fetchSnapshot(business, account, start, end, refresh = false) {
  const key = { business: business._id, locationName: account.locationName, start, end };
  const cached = await PerformanceSnapshot.findOne(key).lean();
  if (!refresh && cached?.fetchedAt && Date.now() - new Date(cached.fetchedAt) < 6 * 3600e3) return cached;
  const payload = await getDailyPerformance(account, Object.keys(METRICS), start, end);
  return PerformanceSnapshot.findOneAndUpdate(key, { ...key, series: normalizePerformance(payload), fetchedAt: new Date() }, { upsert: true, new: true, runValidators: true }).lean();
}

export async function performanceAccount(business) {
  const account = await loadAccount(business._id);
  if (!isLiveConnection(account)) throw new HttpError(409, 'Connect a live Google Business Profile to load performance data');
  return account;
}

export async function completedActivities(business, account) {
  if (!isLiveConnection(account)) return [];
  const [manual, photos, posts] = await Promise.all([
    CompletedActivity.find({ business: business._id, locationName: account.locationName }).sort({ completedAt: -1 }).limit(60).lean(),
    Photo.find({ business: business._id, 'google.syncStatus': 'synced', postedAt: { $exists: true } }).sort({ postedAt: -1 }).limit(60).lean(),
    Post.find({ business: business._id, status: 'published', publishedTo: 'google' }).sort({ publishedAt: -1 }).limit(60).lean(),
  ]);
  const atLocation = (name) => String(name || '').includes(`/${account.locationName}/`);
  return [
    ...manual.map((a) => ({ id: `activity:${a._id}`, title: a.title, completedAt: a.completedAt, source: a.source, kind: a.kind })),
    ...photos.filter((p) => atLocation(p.google?.mediaName)).map((p) => ({ id: `photo:${p._id}`, title: `Photo published: ${p.caption || p.fileName || p.category}`, completedAt: p.postedAt, source: 'google', kind: 'photo' })),
    ...posts.filter((p) => atLocation(p.google?.name)).map((p) => ({ id: `post:${p._id}`, title: `Post published: ${p.title || p.summary.slice(0, 100)}`, completedAt: p.publishedAt, source: 'google', kind: 'post' })),
  ].sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt)).slice(0, 100);
}

export function activityWindows(date, business, days = 14, now = new Date()) {
  const completed = localYmd(new Date(date), safeTz(business.timezone));
  const lastDay = addDaysYmd(localYmd(now, safeTz(business.timezone)), -1);
  const before = { start: addDaysYmd(completed, -days), end: addDaysYmd(completed, -1) };
  const after = { start: addDaysYmd(completed, 1), end: addDaysYmd(completed, days) };
  return { before, after, lastDay, elapsed: after.end <= lastDay };
}
