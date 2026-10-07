import { Post, Photo, Service, Review, GoogleAccount } from '../../models/index.js';
import * as google from '../google/client.js';
import { loadAccount } from '../google/sync.js';
import { generatePost } from '../ai/service.js';
import { answeredFaqs } from '../reviews/service.js';
import { holidayPlan } from '../hours/service.js';
import { env } from '../../config/env.js';
import { addDaysYmd, safeTz, weekStartYmd, ymdToParts, localYmd } from '../../utils/time.js';
import { postSlots } from '../autopilot/slots.js';
import { HttpError } from '../../utils/http.js';

/** Which button a post gets, from the links the business has filled in. */
export function defaultAction(business) {
  const l = business.links || {};
  if (l.booking) return { action: 'BOOK', actionUrl: l.booking };
  if (l.appointment) return { action: 'BOOK', actionUrl: l.appointment };
  if (l.ordering) return { action: 'ORDER', actionUrl: l.ordering };
  if (l.website) return { action: 'LEARN_MORE', actionUrl: l.website };
  if (business.phone) return { action: 'CALL', actionUrl: '' };
  return { action: 'NONE', actionUrl: '' };
}

/** Google localPost body for a post. */
export function toGooglePost(post, photo) {
  const body = { languageCode: 'en', summary: post.summary, topicType: post.type || 'STANDARD' };
  if (post.action && post.action !== 'NONE') {
    body.callToAction = post.action === 'CALL' ? { actionType: 'CALL' } : { actionType: post.action, url: post.actionUrl };
  }
  if (photo?.fileUrl) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: `${env.publicAssetUrl}${photo.fileUrl}` }];
  if (post.type === 'EVENT' || post.type === 'OFFER') {
    body.event = {
      title: post.title,
      schedule: { startDate: ymdToParts(post.startDate), endDate: ymdToParts(post.endDate || post.startDate) },
    };
  }
  if (post.type === 'OFFER') {
    body.offer = {
      ...(post.couponCode ? { couponCode: post.couponCode } : {}),
      ...(post.redeemUrl ? { redeemOnlineUrl: post.redeemUrl } : {}),
      ...(post.terms ? { termsConditions: post.terms } : {}),
    };
  }
  return body;
}

export function validatePost(post) {
  if (!post.summary?.trim()) return 'Write the post text';
  const looksLikePhone = (post.summary.match(/\+?\d[\d\s-]{7,}\d/g) || []).some((m) => m.replace(/\D/g, '').length >= 10);
  if (looksLikePhone) return 'Google rejects posts with phone numbers in the text — use the Call button instead';
  if (post.action && !['NONE', 'CALL'].includes(post.action) && !/^https?:\/\//.test(post.actionUrl || '')) return 'Add the link for the button';
  if ((post.type === 'EVENT' || post.type === 'OFFER') && (!post.title?.trim() || !post.startDate)) return `${post.type === 'OFFER' ? 'Offers' : 'Events'} need a title and a start date`;
  return null;
}

/** Sends one post to Google (or marks it in demo). Never claims success Google didn't confirm. */
export async function publishPost(post, business) {
  const problem = validatePost(post);
  if (problem) throw new HttpError(400, problem);
  const account = await loadAccount(business._id);
  if (!account) throw new HttpError(409, 'Connect your Google Business Profile to publish posts');
  const photo = post.photo ? await Photo.findById(post.photo) : null;

  if (account.mode === 'demo') {
    Object.assign(post, { status: 'published', publishedAt: new Date(), publishedTo: 'demo', error: undefined });
    await post.save();
    return post;
  }
  if (!account.locationName) throw new HttpError(409, 'Choose your Google location first');
  if (photo && !/^https:\/\//.test(env.publicAssetUrl)) throw new HttpError(400, 'Photos need a public https address. Set PUBLIC_ASSET_URL.');
  try {
    const created = await google.createLocalPost(account, toGooglePost(post, photo));
    Object.assign(post, {
      status: 'published', publishedAt: new Date(), publishedTo: 'google', error: undefined,
      google: { name: created.name, searchUrl: created.searchUrl, state: created.state },
    });
  } catch (err) {
    Object.assign(post, { status: 'failed', error: err.message });
  }
  await post.save();
  return post;
}

export async function removeFromGoogle(post, business) {
  if (post.publishedTo !== 'google' || !post.google?.name) return;
  const account = await loadAccount(business._id);
  if (account?.mode === 'live') await google.deleteLocalPost(account, post.google.name).catch((err) => {
    if (err.googleStatus !== 404) throw err;
  });
}

/* --------------------------------------------------------------- planning */

const ROTATION = ['service', 'reviews', 'tip', 'faq', 'service', 'team'];
const PHOTO_FOR_THEME = {
  service: ['services', 'products', 'before_after'],
  tip: ['services', 'products', 'before_after'],
  team: ['team', 'interior'],
  festival: ['interior', 'exterior', 'events', 'team'],
  reviews: ['interior', 'team', 'services'],
  faq: ['interior', 'exterior', 'services'],
};

async function pickPhoto(businessId, theme) {
  const since = new Date(Date.now() - 45 * 864e5);
  const recent = await Post.find({ business: businessId, photo: { $exists: true }, createdAt: { $gte: since } }).select('photo').lean();
  const used = recent.map((p) => p.photo);
  const prefer = PHOTO_FOR_THEME[theme] || [];
  const base = { business: businessId, _id: { $nin: used }, category: { $nin: ['logo'] } };
  return (await Photo.findOne({ ...base, category: { $in: prefer } }).sort({ createdAt: -1 }))
    || (await Photo.findOne(base).sort({ createdAt: -1 }));
}

async function praisedThemes(businessId) {
  const rows = await Review.find({ business: businessId, rating: { $gte: 4 }, 'analysis.positives.0': { $exists: true } }).sort({ createTime: -1 }).limit(40).select('analysis.positives').lean();
  const counts = {};
  for (const r of rows) for (const p of r.analysis.positives || []) counts[p] = (counts[p] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 3);
}

/** Picks what the next weekly post is about, rotating so posts don't repeat. */
async function chooseTopic(business, slotYmd) {
  const tz = safeTz(business.timezone);
  const [services, faqs, praised, aiCount, recent] = await Promise.all([
    Service.find({ business: business._id, active: true }).lean(),
    answeredFaqs(business._id),
    praisedThemes(business._id),
    Post.countDocuments({ business: business._id, source: 'ai' }),
    Post.find({ business: business._id }).sort({ createdAt: -1 }).limit(12).select('theme featured').lean(),
  ]);

  // A festival in the week after this slot gets its own greeting post
  const slotDate = new Date(`${slotYmd}T12:00:00Z`);
  const festival = holidayPlan(business, { days: 60, date: new Date(Math.max(Date.now(), slotDate.getTime() - 864e5)) })
    .find((h) => h.date >= slotYmd && h.date <= addDaysYmd(slotYmd, 6) && !recent.some((p) => p.theme === 'festival' && p.featured === h.name));
  if (festival) {
    const s = festival.special;
    const hoursNote = s ? (s.closed ? 'closed' : `open ${s.open} to ${s.close}`) : '';
    return { theme: 'festival', featured: { name: festival.name, date: festival.date, hoursNote }, featuredKey: festival.name, services, faqs };
  }

  for (let i = 0; i < ROTATION.length; i += 1) {
    const theme = ROTATION[(aiCount + i) % ROTATION.length];
    if (theme === 'service' || theme === 'tip') {
      if (!services.length) continue;
      const recentNames = recent.map((p) => p.featured);
      const svc = services.find((s) => !recentNames.includes(s.name)) || services[aiCount % services.length];
      return { theme, featured: svc, featuredKey: svc.name, services, faqs };
    }
    if (theme === 'reviews') {
      if (praised.length < 2) continue;
      return { theme, featured: { praised }, featuredKey: 'reviews', services, faqs };
    }
    if (theme === 'faq') {
      const q = faqs.find((f) => !recent.some((p) => p.featured === f.question));
      if (!q) continue;
      return { theme, featured: q, featuredKey: q.question, services, faqs };
    }
    return { theme, featured: null, featuredKey: theme, services, faqs };
  }
  return { theme: 'team', featured: null, featuredKey: 'team', services, faqs };
}

/** Writes a post with AI for a topic and returns an unsaved Post. */
export async function draftPostFor(business, { theme, featured, featuredKey, services, faqs, instruction, type = 'STANDARD' }) {
  const { summary, title, model } = await generatePost({ business, services, faqs, theme, featured, type, instruction });
  const photo = await pickPhoto(business._id, theme);
  return new Post({
    business: business._id, type, theme, summary, title, model, source: 'ai',
    featured: featuredKey, photo: photo?._id, ...defaultAction(business),
  });
}

/**
 * Makes sure each weekly post slot in the next ~8 days has a post. AI writes it;
 * it is scheduled straight away when auto-publish is on, otherwise it waits as a draft.
 */
export async function planPosts(business, now = new Date()) {
  const cfg = business.autopilot?.posts || {};
  if (cfg.enabled === false || !cfg.perWeek) return 0;
  const tz = safeTz(business.timezone);
  const horizon = new Date(now.getTime() + 8 * 864e5);
  const thisWeek = weekStartYmd(now, tz);
  let created = 0;
  for (const ws of [thisWeek, addDaysYmd(thisWeek, 7)]) {
    for (const slot of postSlots(ws, cfg, tz)) {
      if (slot.at <= now || slot.at > horizon) continue;
      if (await Post.exists({ business: business._id, slotKey: slot.key })) continue;
      // eslint-disable-next-line no-await-in-loop
      const topic = await chooseTopic(business, slot.ymd);
      const post = await draftPostFor(business, topic);
      post.slotKey = slot.key;
      post.scheduledFor = slot.at;
      post.status = cfg.autoPublish ? 'scheduled' : 'draft';
      await post.save();
      created += 1;
    }
  }
  return created;
}

/** Publishes scheduled posts whose time has come. */
export async function publishDuePosts(business, now = new Date()) {
  const account = await GoogleAccount.findOne({ business: business._id }).select('mode locationName').lean();
  if (!account || (account.mode === 'live' && !account.locationName)) return 0;
  const due = await Post.find({ business: business._id, status: 'scheduled', scheduledFor: { $lte: now } }).sort({ scheduledFor: 1 }).limit(3);
  for (const post of due) {
    try {
      await publishPost(post, business);
    } catch (err) {
      post.status = 'failed';
      post.error = err.message;
      await post.save();
    }
  }
  return due.length;
}

export const todayYmd = (business) => localYmd(new Date(), safeTz(business.timezone));
