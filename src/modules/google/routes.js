import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env, googleConfigured } from '../../config/env.js';
import { requireAuth, requireBusiness } from '../../middleware/auth.js';
import { ah, parse, badRequest, HttpError } from '../../utils/http.js';
import { GoogleAccount, Location, Service, Photo, Review, Business, User } from '../../models/index.js';
import * as google from './client.js';
import * as sync from './sync.js';
import { demoReviews, demoNewReview } from './demo.js';
import { ingestReviews, processNewReviews } from '../reviews/service.js';

export const googleRouter = Router();

export const googleAuthRouter = Router();

// Where the user lands in the frontend after Google. Only paths inside the app are allowed.
const DEFAULT_RETURN = '/app/google';
const safeReturn = (p) => (typeof p === 'string' && /^\/app(\/[A-Za-z0-9/_-]*)?$/.test(p) ? p : DEFAULT_RETURN);
const oauthState = (business, ret) => jwt.sign({ bid: String(business._id), ret: safeReturn(ret) }, env.jwtSecret, { expiresIn: '15m' });

const wantsJson = (req) => req.query.format === 'json' || (req.get('accept') || '').includes('application/json');

/** Signed-in user from the Bearer header, or from ?token= when the browser is sent here by a plain link. */
async function userFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.token || '');
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    if (!payload.sub) return null;
    const user = await User.findById(payload.sub);
    if (!user) return null;
    if (payload.imp) {
      const admin = await User.findById(payload.imp);
      if (!admin?.isAdmin()) return null;
      user.$locals.impersonatedBy = admin;
    }
    return user;
  } catch {
    return null;
  }
}

/**
 * GET /api/auth/google — starts "Connect Google".
 *   Browser link:  /api/auth/google?token=<login token>&return=/app/google  → 302 to Google
 *   From the app:  fetch with Authorization: Bearer <token> and Accept: application/json → { url }
 */
googleAuthRouter.get(
  '/',
  ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    const json = wantsJson(req);
    const ret = safeReturn(req.query.return);
    const fail = (status, message) => {
      if (json) throw new HttpError(status, message);
      return res.redirect(`${env.appUrl}${ret}?${new URLSearchParams({ error: message })}`);
    };

    if (!googleConfigured()) return fail(409, 'Google sign-in is not configured on the server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or try the demo connection.');
    const user = await userFromRequest(req);
    if (!user) {
      if (json) throw new HttpError(401, 'Sign in first');
      return res.redirect(`${env.appUrl}/login?${new URLSearchParams({ next: ret })}`);
    }
    const business = await Business.findOne({ owner: user._id });
    if (!business) return fail(404, 'Create your business first');
    if (business.account?.status === 'suspended' && !user.$locals.impersonatedBy) return fail(403, 'Your account is paused. Contact us to continue.');

    const url = google.authUrl(oauthState(business, ret));
    if (json) return res.json({ url });
    return res.redirect(302, url);
  })
);

/**
 * GET /api/auth/google/callback — Google sends the browser here with ?code=…&state=…
 * Exchanges the code for tokens, stores the connection (tokens encrypted), picks the
 * location when there is only one, then sends the user back to the frontend.
 */
const oauthCallback = ah(async (req, res) => {
  let state = null;
  try {
    state = jwt.verify(String(req.query.state || ''), env.jwtSecret);
  } catch {
    /* handled below */
  }
  const ret = safeReturn(state?.ret);
  const back = (q) => res.redirect(`${env.appUrl}${ret}?${new URLSearchParams(q)}`);
  if (req.query.error) return back({ error: req.query.error === 'access_denied' ? 'Google access was not allowed. Try again and press Allow.' : String(req.query.error) });
  if (!state?.bid) return back({ error: 'The sign-in link expired. Try connecting again.' });
  if (!req.query.code) return back({ error: 'Google did not send a sign-in code. Try connecting again.' });
  const business = await Business.findById(state.bid);
  if (!business) return back({ error: 'Business not found' });

  let tokens;
  try {
    tokens = await google.exchangeCode(String(req.query.code));
  } catch (err) {
    // Usually a redirect URI mismatch or a wrong client secret on the server
    return back({ error: `Google sign-in failed: ${err.message}. Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.` });
  }
  if (!tokens.refresh_token) {
    const existing = await GoogleAccount.findOne({ business: business._id, mode: 'live' }).select('+refreshTokenEnc');
    if (!existing?.refreshTokenEnc) return back({ error: 'Google didn’t give long-term access. Remove Starling at myaccount.google.com/permissions and connect again.' });
  }
  let account = await GoogleAccount.findOne({ business: business._id }).select('+accessTokenEnc +refreshTokenEnc');
  if (account && account.mode === 'demo') {
    // Replace demo data with the real profile
    await Review.deleteMany({ business: business._id, source: 'demo' });
    await account.deleteOne();
    account = null;
  }
  if (!account) account = new GoogleAccount({ business: business._id, mode: 'live' });
  account.mode = 'live';
  account.setTokens(tokens);
  account.email = await google.fetchUserEmail(tokens.access_token);
  account.status = 'needs_location';
  account.lastError = undefined;
  await account.save();

  // Auto-select when there is exactly one location
  try {
    const all = await listAllLocations(account);
    if (all.length === 1) {
      await selectLocation(business, account, all[0]);
      return back({ connected: '1' });
    }
  } catch (err) {
    account.lastError = err.message;
    await account.save();
  }
  return back({ choose: '1' });
});

googleAuthRouter.get('/callback', oauthCallback);
// Older address for the same callback, kept so existing Google Cloud settings keep working
googleRouter.get('/oauth/callback', oauthCallback);

googleRouter.use(requireAuth, requireBusiness);

async function listAllLocations(account) {
  const accounts = await google.listAccounts(account);
  const out = [];
  for (const a of accounts) {
    const locs = await google.listLocations(account, a.name);
    for (const l of locs) {
      out.push({
        accountName: a.name,
        accountTitle: a.accountName,
        locationName: l.name,
        title: l.title,
        address: google.formatAddress(l.storefrontAddress),
        placeId: l.metadata?.placeId,
        newReviewUri: l.metadata?.newReviewUri,
        mapsUri: l.metadata?.mapsUri,
        primaryCategory: l.categories?.primaryCategory?.name,
        verified: l.metadata?.hasVoiceOfMerchant,
        raw: l,
      });
    }
  }
  return out;
}

async function selectLocation(business, account, loc) {
  account.accountName = loc.accountName;
  account.locationName = loc.locationName;
  account.locationTitle = loc.title;
  account.status = 'connected';
  await account.save();

  await Location.updateMany({ business: business._id }, { isPrimary: false });
  await Location.findOneAndUpdate(
    { business: business._id, 'google.locationName': loc.locationName },
    {
      business: business._id,
      title: loc.title,
      address: loc.address,
      isPrimary: true,
      google: {
        accountName: loc.accountName,
        locationName: loc.locationName,
        placeId: loc.placeId,
        newReviewUri: loc.newReviewUri,
        mapsUri: loc.mapsUri,
        primaryCategory: loc.primaryCategory,
      },
    },
    { upsert: true, new: true }
  );

  // Fill empty profile fields from Google (never overwrite what the owner typed)
  const raw = loc.raw || {};
  if (!business.phone && raw.phoneNumbers?.primaryPhone) business.phone = raw.phoneNumbers.primaryPhone;
  if (!business.links?.website && raw.websiteUri) business.links.website = raw.websiteUri;
  if (!business.description && raw.profile?.description) business.description = raw.profile.description.slice(0, 750);
  if (!business.address?.line1 && raw.storefrontAddress) {
    const a = raw.storefrontAddress;
    business.address = {
      line1: (a.addressLines || []).join(', '),
      city: a.locality || '',
      state: a.administrativeArea || '',
      postalCode: a.postalCode || '',
      country: a.regionCode || 'IN',
    };
  }
  if (loc.newReviewUri) business.reviewLink = loc.newReviewUri;
  else if (loc.placeId) business.reviewLink = `https://search.google.com/local/writereview?placeid=${loc.placeId}`;
  business.onboarding.google = true;
  await business.save();

  await sync.refreshRemoteSnapshot(business).catch(() => null);
  // Initial import runs in the background so the redirect is instant
  sync.syncReviews(business).catch((err) => console.warn('[google] initial sync failed:', err.message));
}

googleRouter.get(
  '/status',
  ah(async (req, res) => {
    const account = await GoogleAccount.findOne({ business: req.business._id });
    const location = await Location.findOne({ business: req.business._id, isPrimary: true });
    res.json({ googleConfigured: googleConfigured(), account, location, reviewLink: req.business.reviewLink });
  })
);

googleRouter.get(
  '/oauth/url',
  ah(async (req, res) => {
    if (!googleConfigured()) {
      throw new HttpError(409, 'Google sign-in is not configured on the server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or try the demo connection.');
    }
    res.json({ url: google.authUrl(oauthState(req.business, req.query.return)) });
  })
);

googleRouter.get(
  '/locations',
  ah(async (req, res) => {
    const account = await sync.loadAccount(req.business._id);
    if (!account || account.mode !== 'live') throw badRequest('Connect a Google account first');
    const all = await listAllLocations(account);
    res.json({ locations: all.map(({ raw, ...l }) => l) });
  })
);

googleRouter.post(
  '/locations/select',
  ah(async (req, res) => {
    const body = parse(z.object({ locationName: z.string().min(1) }), req.body);
    const account = await sync.loadAccount(req.business._id);
    if (!account || account.mode !== 'live') throw badRequest('Connect a Google account first');
    const all = await listAllLocations(account);
    const loc = all.find((l) => l.locationName === body.locationName);
    if (!loc) throw badRequest('That location is not available on this Google account');
    await selectLocation(req.business, account, loc);
    res.json({ ok: true });
  })
);

/** Sandbox connection with sample reviews so the full workflow can be explored. */
googleRouter.post(
  '/demo',
  ah(async (req, res) => {
    const business = req.business;
    const existing = await GoogleAccount.findOne({ business: business._id });
    if (existing?.mode === 'live') throw new HttpError(409, 'A live Google profile is already connected');

    await GoogleAccount.updateOne(
      { business: business._id },
      { business: business._id, mode: 'demo', email: 'demo@starling.local', locationTitle: business.name, status: 'connected', lastSyncAt: new Date(), accountName: 'accounts/demo', locationName: 'locations/demo' },
      { upsert: true }
    );
    const location = await Location.findOneAndUpdate(
      { business: business._id, 'google.locationName': 'locations/demo' },
      { business: business._id, title: business.name, isPrimary: true, address: [business.address?.line1, business.address?.city].filter(Boolean).join(', '), google: { accountName: 'accounts/demo', locationName: 'locations/demo' }, lastSyncedAt: new Date() },
      { upsert: true, new: true }
    );
    if (!business.reviewLink) business.reviewLink = 'https://search.google.com/local/writereview?placeid=DEMO_PLACE_ID';
    business.onboarding.google = true;
    await business.save();

    const services = await Service.find({ business: business._id, active: true }).lean();
    const created = await ingestReviews(business, demoReviews(services.map((s) => s.name)), { source: 'demo', locationId: location._id });
    // Analyse everything; draft replies only for the recent unanswered ones.
    const recent = (r) => Date.now() - r.createTime.getTime() < 30 * 864e5;
    processInBackground(business, created, recent);
    res.json({ ok: true, imported: created.length });
  })
);

function processInBackground(business, reviews, shouldDraft) {
  (async () => {
    const draftable = reviews.filter((r) => r.status === 'unanswered' && shouldDraft(r));
    const others = reviews.filter((r) => !draftable.includes(r));
    await processNewReviews(business, draftable);
    // analysis only, no drafts
    const noDraft = { ...business.toObject(), automation: { ...business.automation, autoDraftReplies: false } };
    const { analyzeAndStore } = await import('../reviews/service.js');
    const services = await Service.find({ business: business._id, active: true }).lean();
    for (const r of others) {
      try {
        await analyzeAndStore(r, noDraft, services);
      } catch (err) {
        console.warn('[demo] analyze failed', err.message);
      }
    }
  })().catch((err) => console.warn('[demo] background processing failed:', err.message));
}

googleRouter.post(
  '/demo/new-review',
  ah(async (req, res) => {
    const account = await GoogleAccount.findOne({ business: req.business._id });
    if (account?.mode !== 'demo') throw badRequest('Simulated reviews are only available on the demo connection');
    const body = parse(z.object({ reviewerName: z.string().max(80).optional() }), req.body || {});
    const services = await Service.find({ business: req.business._id, active: true }).lean();
    const location = await Location.findOne({ business: req.business._id, isPrimary: true });
    const created = await ingestReviews(req.business, [demoNewReview(services.map((s) => s.name), body)], { source: 'demo', locationId: location?._id });
    await processNewReviews(req.business, created);
    const review = await Review.findById(created[0]._id);
    res.status(201).json({ review });
  })
);

googleRouter.post(
  '/sync',
  ah(async (req, res) => {
    const account = await GoogleAccount.findOne({ business: req.business._id });
    if (!account) throw badRequest('Connect Google first');
    if (account.mode === 'demo') return res.json({ created: 0, total: await Review.countDocuments({ business: req.business._id }), demo: true });
    const result = await sync.syncReviews(req.business);
    res.json(result);
  })
);

googleRouter.post(
  '/refresh',
  ah(async (req, res) => {
    const remote = await sync.refreshRemoteSnapshot(req.business);
    res.json({ remote });
  })
);

googleRouter.get('/sync-status', ah(async (req, res) => res.json(await sync.syncStatus(req.business))));

googleRouter.post(
  '/push/profile',
  ah(async (req, res) => {
    const body = parse(z.object({ sections: z.array(z.enum(['name', 'phone', 'website', 'description', 'hours', 'specialHours'])).min(1) }), req.body);
    const results = await sync.pushProfile(req.business, body.sections);
    res.json({ results, status: await sync.syncStatus(req.business) });
  })
);

googleRouter.post(
  '/push/services',
  ah(async (req, res) => {
    const result = await sync.pushServices(req.business);
    res.json({ result, status: await sync.syncStatus(req.business) });
  })
);

googleRouter.post(
  '/push/photos',
  ah(async (req, res) => {
    const body = parse(z.object({ ids: z.array(z.string()).min(1).max(20) }), req.body);
    const photos = await Photo.find({ _id: { $in: body.ids }, business: req.business._id });
    const out = [];
    for (const p of photos) out.push(await sync.pushPhoto(req.business, p));
    res.json({ photos: out });
  })
);

googleRouter.delete(
  '/',
  ah(async (req, res) => {
    const account = await sync.loadAccount(req.business._id);
    if (account) {
      if (account.mode === 'live') {
        const token = account.getRefreshToken() || account.getAccessToken();
        if (token) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
      } else {
        await Review.deleteMany({ business: req.business._id, source: 'demo' });
        const { AiResponse } = await import('../../models/index.js');
        await AiResponse.deleteMany({ business: req.business._id });
      }
      await account.deleteOne();
    }
    await Location.deleteMany({ business: req.business._id });
    req.business.onboarding.google = false;
    await req.business.save();
    res.json({ ok: true });
  })
);
