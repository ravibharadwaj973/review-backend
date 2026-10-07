import { Business, GoogleAccount } from '../../models/index.js';
import { publishDueReplies } from '../reviews/service.js';
import { planPhotos, postDuePhotos } from '../photos/schedule.js';
import { planPosts, publishDuePosts } from '../posts/service.js';
import { effectiveHours, hoursSignature } from '../hours/service.js';
import { pushProfile } from '../google/sync.js';

/**
 * Switches Google's weekly hours when a seasonal schedule starts or ends.
 * The first run only records the current hours, so Google is never overwritten
 * by hours the owner hasn't touched.
 */
export async function applySeasonalHours(business, account) {
  const sig = hoursSignature(effectiveHours(business));
  if (!business.googleHoursSig) {
    business.googleHoursSig = sig;
    await business.save();
    return false;
  }
  if (business.googleHoursSig === sig) return false;
  if (!account || account.mode !== 'live' || business.automation?.syncHoursToGoogle === false) {
    business.googleHoursSig = sig;
    await business.save();
    return false;
  }
  const res = await pushProfile(business, ['hours']);
  if (res.hours?.status !== 'synced') console.warn(`[autopilot] ${business.name}: seasonal hours not accepted: ${res.hours?.message}`);
  return res.hours?.status === 'synced';
}

/** One autopilot pass for one business. Each step is independent so one failure doesn't stop the rest. */
export async function runAutopilotFor(business, now = new Date()) {
  const account = await GoogleAccount.findOne({ business: business._id }).select('mode status locationName').lean();
  const out = {};
  const step = async (name, fn) => {
    try {
      out[name] = await fn();
    } catch (err) {
      out[name] = { error: err.message };
      console.warn(`[autopilot] ${business.name}: ${name} failed: ${err.message}`);
    }
  };
  await step('photosPosted', () => postDuePhotos(business, now));
  await step('photosPlanned', () => planPhotos(business, now));
  await step('postsPublished', () => publishDuePosts(business, now));
  // AI-written posts are only planned once a Google profile (or the demo) is connected
  if (account) await step('postsPlanned', () => planPosts(business, now));
  await step('hours', () => applySeasonalHours(business, account));
  return out;
}

let running = false;

/** Runs autopilot for every business. Used by the worker. */
export async function runAutopilotAll() {
  if (running) return null;
  running = true;
  const started = Date.now();
  try {
    const replies = await publishDueReplies().catch((err) => {
      console.warn('[autopilot] replies failed:', err.message);
      return 0;
    });
    const businesses = await Business.find({});
    let photos = 0;
    let posts = 0;
    for (const b of businesses) {
      const r = await runAutopilotFor(b);
      photos += Number(r.photosPosted) || 0;
      posts += Number(r.postsPublished) || 0;
    }
    if (replies || photos || posts) console.log(`[autopilot] ${replies} reply(s), ${photos} photo(s), ${posts} post(s) published in ${Date.now() - started}ms`);
    return { replies, photos, posts };
  } finally {
    running = false;
  }
}
