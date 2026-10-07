import { Photo, GoogleAccount } from '../../models/index.js';
import { pushPhoto } from '../google/sync.js';
import { addDaysYmd, safeTz, weekStartYmd, zonedDate } from '../../utils/time.js';
import { photoSlots } from '../autopilot/slots.js';

const NOT_QUEUED = ['logo', 'cover'];

export const canQueue = (photo) => !NOT_QUEUED.includes(photo.category);

/** Photos posted in the week starting weekStart. */
export async function postedInWeek(businessId, weekStart, tz) {
  return Photo.countDocuments({
    business: businessId,
    postedAt: { $gte: zonedDate(weekStart, '00:00', tz), $lt: zonedDate(addDaysYmd(weekStart, 7), '00:00', tz) },
  });
}

/**
 * Gives queued photos their posting times: perWeek per week on spread-out days,
 * counting photos already posted this week. Photos beyond the next three weeks wait.
 */
export async function planPhotos(business, now = new Date()) {
  const cfg = business.autopilot?.photos || {};
  const tz = safeTz(business.timezone);
  const queued = await Photo.find({ business: business._id, queued: true }).sort({ queuePosition: 1, createdAt: 1 });
  const perWeek = cfg.enabled === false ? 0 : Number(cfg.perWeek ?? 4);

  const slots = [];
  if (perWeek > 0) {
    const thisWeek = weekStartYmd(now, tz);
    for (let w = 0; w < 3 && slots.length < queued.length; w += 1) {
      const ws = addDaysYmd(thisWeek, 7 * w);
      const future = photoSlots(ws, perWeek, tz).filter((s) => s.at > now);
      const already = w === 0 ? await postedInWeek(business._id, ws, tz) : 0;
      slots.push(...future.slice(0, Math.max(0, perWeek - already)));
    }
  }

  const ops = [];
  queued.forEach((p, i) => {
    const at = slots[i]?.at || null;
    if (String(p.scheduledFor || '') !== String(at || '')) ops.push({ updateOne: { filter: { _id: p._id }, update: at ? { $set: { scheduledFor: at } } : { $unset: { scheduledFor: 1 } } } });
  });
  for (const op of ops) await Photo.updateOne(op.updateOne.filter, op.updateOne.update);
  return { queued: queued.length, scheduled: Math.min(queued.length, slots.length) };
}

/** Posts one photo to Google now and takes it out of the queue. */
export async function postPhotoNow(business, photo) {
  await pushPhoto(business, photo);
  const ok = ['synced', 'demo'].includes(photo.google?.syncStatus);
  photo.queued = false;
  photo.scheduledFor = undefined;
  if (ok) photo.postedAt = new Date();
  await photo.save();
  return photo;
}

/** Posts queued photos whose time has come (a couple per run). Needs a Google connection. */
export async function postDuePhotos(business, now = new Date()) {
  const account = await GoogleAccount.findOne({ business: business._id }).select('mode status locationName').lean();
  if (!account || (account.mode === 'live' && !account.locationName)) return 0;
  const due = await Photo.find({ business: business._id, queued: true, scheduledFor: { $lte: now } }).sort({ scheduledFor: 1 }).limit(2);
  for (const photo of due) await postPhotoNow(business, photo);
  return due.length;
}

export async function nextQueuePosition(businessId) {
  const last = await Photo.findOne({ business: businessId, queued: true }).sort({ queuePosition: -1 }).select('queuePosition').lean();
  return (last?.queuePosition ?? 0) + 1;
}
