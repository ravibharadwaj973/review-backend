import { Review, ReviewRequest, AiResponse, Customer } from '../../models/index.js';

const MONTH = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const round = (n, p = 1) => (Number.isFinite(n) ? Number(n.toFixed(p)) : 0);
const startOfMonth = (offset = 0) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + offset, 1);
};

export async function reviewOverview(businessId) {
  const all = await Review.find({ business: businessId })
    .select('rating createTime status reply analysis.sentiment source')
    .lean();
  // Rating, volume and response metrics describe the Google profile; in-app reviews are counted separately
  const reviews = all.filter((r) => r.source !== 'direct');
  const direct = all.filter((r) => r.source === 'direct');

  const total = reviews.length;
  const avg = total ? reviews.reduce((s, r) => s + r.rating, 0) / total : 0;
  const thisMonthStart = startOfMonth(0);
  const lastMonthStart = startOfMonth(-1);
  const thisMonth = reviews.filter((r) => r.createTime >= thisMonthStart);
  const lastMonth = reviews.filter((r) => r.createTime >= lastMonthStart && r.createTime < thisMonthStart);
  const last30 = reviews.filter((r) => r.createTime >= new Date(Date.now() - 30 * 864e5));
  const answered = reviews.filter((r) => r.status === 'answered');
  const unanswered = total - answered.length;

  const responseHours = answered
    .filter((r) => r.reply?.updateTime && r.reply.updateTime > r.createTime)
    .map((r) => (new Date(r.reply.updateTime) - new Date(r.createTime)) / 36e5);
  const avgResponseHours = responseHours.length ? responseHours.reduce((a, b) => a + b, 0) / responseHours.length : null;

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of reviews) distribution[r.rating] += 1;

  const sentiment = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
  for (const r of reviews) {
    const s = r.analysis?.sentiment || (r.rating >= 4 ? 'positive' : r.rating === 3 ? 'neutral' : 'negative');
    sentiment[s] += 1;
  }

  // 12-month series
  const months = [];
  for (let i = 11; i >= 0; i -= 1) months.push(MONTH(startOfMonth(-i)));
  const series = months.map((m) => {
    const list = reviews.filter((r) => MONTH(new Date(r.createTime)) === m);
    return {
      month: m,
      count: list.length,
      avgRating: list.length ? round(list.reduce((s, r) => s + r.rating, 0) / list.length, 2) : null,
      positive: list.filter((r) => r.rating >= 4).length,
      negative: list.filter((r) => r.rating <= 2).length,
    };
  });
  // cumulative average over time
  let running = reviews.filter((r) => r.createTime < startOfMonth(-11));
  let sum = running.reduce((s, r) => s + r.rating, 0);
  let n = running.length;
  for (const point of series) {
    const list = reviews.filter((r) => MONTH(new Date(r.createTime)) === point.month);
    sum += list.reduce((s, r) => s + r.rating, 0);
    n += list.length;
    point.cumulativeAvg = n ? round(sum / n, 2) : null;
    point.cumulativeCount = n;
  }

  return {
    direct: {
      total: direct.length,
      avgRating: direct.length ? round(direct.reduce((x, r) => x + r.rating, 0) / direct.length, 2) : null,
      thisMonth: direct.filter((r) => r.createTime >= thisMonthStart).length,
      unanswered: direct.filter((r) => r.status !== 'answered').length,
    },
    total,
    avgRating: round(avg, 2),
    thisMonth: thisMonth.length,
    lastMonth: lastMonth.length,
    last30: last30.length,
    avgRatingThisMonth: thisMonth.length ? round(thisMonth.reduce((s, r) => s + r.rating, 0) / thisMonth.length, 2) : null,
    unanswered,
    responseRate: total ? round((answered.length / total) * 100, 0) : 0,
    avgResponseHours: avgResponseHours == null ? null : round(avgResponseHours, 1),
    distribution,
    sentiment,
    series,
  };
}

export async function topicStats(businessId, { since } = {}) {
  const filter = { business: businessId, 'analysis.analyzedAt': { $exists: true } };
  if (since) filter.createTime = { $gte: since };
  const reviews = await Review.find(filter).select('rating createTime analysis').lean();
  const praised = new Map();
  const criticized = new Map();
  const services = new Map();
  const keywords = new Map();
  const recentCut = Date.now() - 60 * 864e5;
  const bump = (map, key, review) => {
    const e = map.get(key) || { topic: key, count: 0, recent: 0, ratingSum: 0 };
    e.count += 1;
    e.ratingSum += review.rating;
    if (new Date(review.createTime).getTime() >= recentCut) e.recent += 1;
    map.set(key, e);
  };
  for (const r of reviews) {
    for (const p of r.analysis?.positives || []) bump(praised, p, r);
    for (const n of r.analysis?.negatives || []) bump(criticized, n, r);
    for (const s of r.analysis?.services || []) bump(services, s, r);
    for (const k of r.analysis?.keywords || []) keywords.set(k.toLowerCase(), (keywords.get(k.toLowerCase()) || 0) + 1);
  }
  const finish = (map) => [...map.values()].map(({ ratingSum, ...e }) => ({ ...e, avgRating: round(ratingSum / e.count, 2) })).sort((a, b) => b.count - a.count);
  return {
    analyzed: reviews.length,
    praised: finish(praised).slice(0, 10),
    criticized: finish(criticized).slice(0, 10),
    byService: finish(services).map(({ topic, ...e }) => ({ service: topic, ...e })).slice(0, 15),
    keywords: [...keywords.entries()].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count).slice(0, 20),
  };
}

export async function requestFunnel(businessId) {
  const requests = await ReviewRequest.find({ business: businessId }).select('status sentAt clickedAt reviewedAt openedAt createdAt channel').lean();
  const sent = requests.filter((r) => ['sent', 'clicked', 'reviewed'].includes(r.status) || r.sentAt);
  const opened = requests.filter((r) => r.openedAt);
  const clicked = requests.filter((r) => r.clickedAt);
  const reviewed = requests.filter((r) => r.status === 'reviewed');
  const byChannel = {};
  for (const r of sent) {
    byChannel[r.channel] = byChannel[r.channel] || { sent: 0, clicked: 0, reviewed: 0 };
    byChannel[r.channel].sent += 1;
    if (r.clickedAt) byChannel[r.channel].clicked += 1;
    if (r.status === 'reviewed') byChannel[r.channel].reviewed += 1;
  }
  const completedCustomers = await Customer.countDocuments({ business: businessId, 'visits.0': { $exists: true } });
  return {
    customersWithVisits: completedCustomers,
    created: requests.length,
    drafts: requests.filter((r) => r.status === 'draft').length,
    sent: sent.length,
    opened: opened.length,
    clicked: clicked.length,
    reviewed: reviewed.length,
    conversionRate: sent.length ? round((reviewed.length / sent.length) * 100, 1) : 0,
    clickRate: sent.length ? round((clicked.length / sent.length) * 100, 1) : 0,
    byChannel,
  };
}

export async function aiMetrics(businessId) {
  const [analyzed, generated, approved, published, edited] = await Promise.all([
    Review.countDocuments({ business: businessId, 'analysis.analyzedAt': { $exists: true } }),
    AiResponse.countDocuments({ business: businessId }),
    AiResponse.countDocuments({ business: businessId, status: { $in: ['approved', 'published'] } }),
    AiResponse.countDocuments({ business: businessId, status: 'published' }),
    AiResponse.countDocuments({ business: businessId, status: 'published', edited: true }),
  ]);
  return { analyzed, generated, approved, published, edited, editRate: published ? round((edited / published) * 100, 0) : 0 };
}
