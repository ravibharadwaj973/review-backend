import { GoogleAccount, Location, Service, Photo, Business } from '../../models/index.js';
import { GOOGLE_MEDIA_CATEGORY } from '../../models/Photo.js';
import * as google from './client.js';
import { ingestReviews, fromGoogleReview, processNewReviews } from '../reviews/service.js';
import { env } from '../../config/env.js';

export async function loadAccount(businessId) {
  return GoogleAccount.findOne({ business: businessId }).select('+accessTokenEnc +refreshTokenEnc');
}

/** Pulls reviews from Google for one business and runs the AI pipeline on new ones. */
export async function syncReviews(business) {
  const account = await loadAccount(business._id);
  if (!account || account.mode !== 'live' || !account.locationName) return { created: 0, total: 0, skipped: true };
  const location = await Location.findOne({ business: business._id, 'google.locationName': account.locationName });
  try {
    const { reviews } = await google.listAllReviews(account);
    const created = await ingestReviews(business, reviews.map(fromGoogleReview), { source: 'google', locationId: location?._id });
    account.lastSyncAt = new Date();
    account.lastError = undefined;
    account.status = 'connected';
    await account.save();
    if (location) {
      location.lastSyncedAt = new Date();
      await location.save();
    }
    await processNewReviews(business, created);
    return { created: created.length, total: reviews.length };
  } catch (err) {
    account.lastError = err.message;
    if (err.googleStatus === 401 || err.googleStatus === 403) account.status = 'error';
    await account.save();
    throw err;
  }
}

/** Reads the current Google profile so the app can show what is / isn't in sync. */
export async function refreshRemoteSnapshot(business) {
  const account = await loadAccount(business._id);
  if (!account || account.mode !== 'live' || !account.locationName) return null;
  const loc = await google.getLocation(account, account.locationName);
  let photoCount;
  try {
    const media = await google.listMedia(account);
    photoCount = media.totalMediaItemCount ?? (media.mediaItems || []).length;
  } catch {
    photoCount = undefined;
  }
  account.remote = {
    title: loc.title,
    phone: loc.phoneNumbers?.primaryPhone || '',
    website: loc.websiteUri || '',
    description: loc.profile?.description || '',
    address: google.formatAddress(loc.storefrontAddress),
    hours: google.hoursFromGoogle(loc.regularHours),
    serviceCount: (loc.serviceItems || []).length,
    photoCount,
    fetchedAt: new Date(),
  };
  await account.save();
  return account.remote;
}

const SECTION_MASKS = {
  name: ['title'],
  phone: ['phoneNumbers'],
  website: ['websiteUri'],
  description: ['profile.description'],
  hours: ['regularHours'],
};

/**
 * Pushes selected profile sections to Google. Only fields the Business Information API
 * accepts are sent; each section's result is reported separately so the UI never claims
 * a sync that Google did not accept.
 */
export async function pushProfile(business, sections) {
  const account = await loadAccount(business._id);
  const results = {};
  if (!account) throw Object.assign(new Error('Connect Google first'), { status: 409 });

  if (account.mode === 'demo') {
    for (const s of sections) results[s] = { status: 'demo', message: 'Demo connection — nothing was sent to Google' };
    return results;
  }

  for (const section of sections) {
    const mask = SECTION_MASKS[section];
    if (!mask) {
      results[section] = { status: 'unsupported', message: 'Google does not accept this field through the API' };
      continue;
    }
    const patch = {};
    if (section === 'name') patch.title = business.name;
    if (section === 'phone') patch.phoneNumbers = { primaryPhone: business.phone };
    if (section === 'website') patch.websiteUri = business.links?.website || '';
    if (section === 'description') patch.profile = { description: business.description };
    if (section === 'hours') patch.regularHours = google.hoursToGoogle(business.hours);
    try {
      await google.updateLocation(account, account.locationName, patch, mask);
      results[section] = { status: 'synced' };
    } catch (err) {
      results[section] = { status: 'failed', message: err.message };
    }
  }
  await refreshRemoteSnapshot(business).catch(() => null);
  return results;
}

/** Publishes the service menu as free-form service items under the primary category. */
export async function pushServices(business) {
  const account = await loadAccount(business._id);
  if (!account) throw Object.assign(new Error('Connect Google first'), { status: 409 });
  const services = await Service.find({ business: business._id, active: true }).sort({ sortOrder: 1, name: 1 });

  if (account.mode === 'demo') {
    await Service.updateMany({ business: business._id, active: true }, { 'google.syncStatus': 'demo', 'google.syncedAt': new Date(), 'google.error': null });
    return { status: 'demo', count: services.length };
  }

  const location = await Location.findOne({ business: business._id, 'google.locationName': account.locationName });
  const category = location?.google?.primaryCategory;
  if (!category) {
    return { status: 'failed', message: 'Your Google profile has no primary category, which Google requires for services' };
  }
  const serviceItems = services.map((s) => ({
    freeFormServiceItem: {
      category,
      label: { displayName: s.name.slice(0, 140), description: (s.description || '').slice(0, 250), languageCode: 'en' },
    },
    ...(s.price != null ? { price: { currencyCode: business.currency || 'INR', units: String(Math.round(s.price)) } } : {}),
  }));
  try {
    await google.updateLocation(account, account.locationName, { serviceItems }, ['serviceItems']);
    await Service.updateMany({ business: business._id, active: true }, { 'google.syncStatus': 'synced', 'google.syncedAt': new Date(), 'google.error': null });
    await refreshRemoteSnapshot(business).catch(() => null);
    return { status: 'synced', count: services.length };
  } catch (err) {
    await Service.updateMany({ business: business._id, active: true }, { 'google.syncStatus': 'failed', 'google.error': err.message });
    return { status: 'failed', message: err.message };
  }
}

/** Uploads one photo to Google. Google must be able to download it from a public URL. */
export async function pushPhoto(business, photo) {
  const account = await loadAccount(business._id);
  if (!account) throw Object.assign(new Error('Connect Google first'), { status: 409 });
  if (account.mode === 'demo') {
    photo.google = { syncStatus: 'demo', syncedAt: new Date() };
    await photo.save();
    return photo;
  }
  const base = env.publicAssetUrl;
  if (!base || !/^https:\/\//.test(base) || /localhost|127\.0\.0\.1/.test(base)) {
    photo.google = { syncStatus: 'failed', error: 'Google needs a public https address to fetch photos. Set PUBLIC_ASSET_URL to your deployed API URL.' };
    await photo.save();
    return photo;
  }
  try {
    photo.google = { syncStatus: 'pending' };
    await photo.save();
    const media = await google.createMedia(account, {
      sourceUrl: `${base}${photo.fileUrl}`,
      category: GOOGLE_MEDIA_CATEGORY[photo.category] || 'ADDITIONAL',
      description: photo.caption || undefined,
    });
    photo.google = { syncStatus: 'synced', mediaName: media.name, syncedAt: new Date() };
  } catch (err) {
    photo.google = { syncStatus: 'failed', error: err.message };
  }
  await photo.save();
  return photo;
}

/** Compares app data with the last Google snapshot for the Sync Status screen. */
export async function syncStatus(business) {
  const account = await loadAccount(business._id);
  const [serviceCount, servicesSynced, photoCount, photosSynced] = await Promise.all([
    Service.countDocuments({ business: business._id, active: true }),
    Service.countDocuments({ business: business._id, active: true, 'google.syncStatus': { $in: ['synced', 'demo'] } }),
    Photo.countDocuments({ business: business._id }),
    Photo.countDocuments({ business: business._id, 'google.syncStatus': { $in: ['synced', 'demo'] } }),
  ]);
  const r = account?.remote || {};
  const demo = account?.mode === 'demo';
  const norm = (v) => String(v || '').trim().toLowerCase().replace(/\/$/, '');
  const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  const cmp = (app, remote, eq = (a, b) => norm(a) === norm(b)) => {
    if (!account) return 'not_connected';
    if (demo) return 'demo';
    if (!r.fetchedAt) return 'unknown';
    if (!app && !remote) return 'empty';
    return eq(app, remote) ? 'synced' : 'different';
  };
  const hoursEqual = JSON.stringify((business.hours || []).map((h) => [h.day, h.closed ? 'x' : `${h.open}-${h.close}`]))
    === JSON.stringify((r.hours || []).map((h) => [h.day, h.closed ? 'x' : `${h.open}-${h.close}`]));

  const sections = [
    { key: 'name', label: 'Business name', app: business.name, google: r.title, status: cmp(business.name, r.title), pushable: true },
    { key: 'phone', label: 'Phone', app: business.phone, google: r.phone, status: cmp(business.phone, r.phone, (a, b) => digits(a) === digits(b)), pushable: true },
    { key: 'website', label: 'Website', app: business.links?.website, google: r.website, status: cmp(business.links?.website, r.website), pushable: true },
    { key: 'description', label: 'Description', app: business.description, google: r.description, status: cmp(business.description, r.description), pushable: true },
    { key: 'hours', label: 'Opening hours', app: 'Weekly hours', google: r.hours ? 'Weekly hours' : '', status: !account ? 'not_connected' : demo ? 'demo' : !r.fetchedAt ? 'unknown' : hoursEqual ? 'synced' : 'different', pushable: true },
    { key: 'address', label: 'Address', app: [business.address?.line1, business.address?.city].filter(Boolean).join(', '), google: r.address, status: !account ? 'not_connected' : demo ? 'demo' : 'google_managed', pushable: false, note: 'Address changes require Google verification — edit it in Google.' },
    {
      key: 'services', label: 'Services / menu', app: serviceCount, google: demo ? servicesSynced : r.serviceCount ?? null,
      status: !account ? 'not_connected' : demo ? 'demo' : r.serviceCount == null ? 'unknown' : r.serviceCount === serviceCount && servicesSynced === serviceCount ? 'synced' : r.serviceCount > 0 ? 'partial' : 'not_synced',
      pushable: true,
    },
    {
      key: 'photos', label: 'Photos', app: photoCount, google: demo ? photosSynced : photosSynced,
      status: !account ? 'not_connected' : demo ? 'demo' : photoCount === 0 ? 'empty' : photosSynced === photoCount ? 'synced' : photosSynced > 0 ? 'partial' : 'not_synced',
      pushable: true,
    },
  ];
  return { connected: Boolean(account), mode: account?.mode, fetchedAt: r.fetchedAt, sections };
}

/** Runs review sync for every live connection. Used by the worker. */
export async function syncAllBusinesses() {
  const accounts = await GoogleAccount.find({ mode: 'live', status: { $in: ['connected', 'error'] }, locationName: { $exists: true, $ne: null } });
  let created = 0;
  for (const acc of accounts) {
    const business = await Business.findById(acc.business);
    if (!business) continue;
    try {
      const res = await syncReviews(business);
      created += res.created || 0;
    } catch (err) {
      console.warn(`[sync] ${business.name}: ${err.message}`);
    }
  }
  return { accounts: accounts.length, created };
}
