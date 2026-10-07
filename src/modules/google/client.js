import { env } from '../../config/env.js';
import { HttpError } from '../../utils/http.js';

/**
 * Thin client for the Google Business Profile APIs.
 * - Account Management:     mybusinessaccountmanagement.googleapis.com/v1
 * - Business Information:   mybusinessbusinessinformation.googleapis.com/v1
 * - Reviews / Media (v4):   mybusiness.googleapis.com/v4
 * Access to these APIs must be requested from Google for your Cloud project.
 */

export const SCOPES = ['https://www.googleapis.com/auth/business.manage', 'openid', 'email'];

const ACCOUNT_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const V4_API = 'https://mybusiness.googleapis.com/v4';

export function authUrl(state) {
  const params = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: env.google.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.google.clientId, client_secret: env.google.clientSecret, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Google sign-in failed: ${data.error_description || data.error || res.status}`);
  return data;
}

export const exchangeCode = (code) =>
  tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: env.google.redirectUri });

export const refreshAccessToken = (refreshToken) =>
  tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });

export async function fetchUserEmail(accessToken) {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return '';
  const data = await res.json();
  return data.email || '';
}

/** Returns a valid access token for the account, refreshing and persisting when expired. */
export async function ensureAccessToken(account) {
  if (account.expiresAt && account.expiresAt > new Date(Date.now() + 30_000)) return account.getAccessToken();
  const refresh = account.getRefreshToken();
  if (!refresh) throw new HttpError(401, 'Google connection expired. Reconnect your Google Business Profile.');
  try {
    const tokens = await refreshAccessToken(refresh);
    account.setTokens(tokens);
    await account.save();
    return tokens.access_token;
  } catch (err) {
    account.status = 'revoked';
    account.lastError = err.message;
    await account.save();
    throw err;
  }
}

async function call(account, url, { method = 'GET', body } = {}) {
  const token = await ensureAccessToken(account);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Google API error ${res.status}`;
    const err = new HttpError(res.status === 401 ? 401 : 502, msg);
    err.googleStatus = res.status;
    throw err;
  }
  return data;
}

// ---- Accounts & locations -------------------------------------------------

export async function listAccounts(account) {
  const data = await call(account, `${ACCOUNT_API}/accounts?pageSize=20`);
  return data.accounts || [];
}

const LOCATION_READ_MASK = [
  'name', 'title', 'phoneNumbers', 'categories', 'storefrontAddress', 'websiteUri',
  'regularHours', 'specialHours', 'profile', 'metadata', 'serviceItems',
].join(',');

export async function listLocations(account, accountName) {
  const data = await call(account, `${INFO_API}/${accountName}/locations?pageSize=100&readMask=${LOCATION_READ_MASK}`);
  return data.locations || [];
}

export function getLocation(account, locationName) {
  return call(account, `${INFO_API}/${locationName}?readMask=${LOCATION_READ_MASK}`);
}

export function updateLocation(account, locationName, patch, updateMask) {
  return call(account, `${INFO_API}/${locationName}?updateMask=${encodeURIComponent(updateMask.join(','))}`, {
    method: 'PATCH',
    body: patch,
  });
}

// ---- Reviews (v4) ---------------------------------------------------------

const v4Location = (account) => `${V4_API}/${account.accountName}/${account.locationName}`;

export async function listAllReviews(account, { maxPages = 20 } = {}) {
  const reviews = [];
  let pageToken = '';
  let summary = {};
  for (let i = 0; i < maxPages; i += 1) {
    const qs = new URLSearchParams({ pageSize: '50', orderBy: 'updateTime desc' });
    if (pageToken) qs.set('pageToken', pageToken);
    const data = await call(account, `${v4Location(account)}/reviews?${qs}`);
    reviews.push(...(data.reviews || []));
    summary = { averageRating: data.averageRating, totalReviewCount: data.totalReviewCount };
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return { reviews, summary };
}

export function putReply(account, reviewId, comment) {
  return call(account, `${v4Location(account)}/reviews/${reviewId}/reply`, { method: 'PUT', body: { comment } });
}

export function deleteReply(account, reviewId) {
  return call(account, `${v4Location(account)}/reviews/${reviewId}/reply`, { method: 'DELETE' });
}

// ---- Media (v4) -----------------------------------------------------------

export function listMedia(account) {
  return call(account, `${v4Location(account)}/media?pageSize=100`);
}

/** Google fetches the photo from sourceUrl, so it must be a public https URL. */
export function createMedia(account, { sourceUrl, category, description }) {
  return call(account, `${v4Location(account)}/media`, {
    method: 'POST',
    body: { mediaFormat: 'PHOTO', locationAssociation: { category }, sourceUrl, description },
  });
}

// ---- Posts (v4 localPosts) -------------------------------------------------

export function createLocalPost(account, body) {
  return call(account, `${v4Location(account)}/localPosts`, { method: 'POST', body });
}

/** name is the full resource name returned when the post was created */
export function deleteLocalPost(account, name) {
  return call(account, `${V4_API}/${name}`, { method: 'DELETE' });
}

// ---- Mapping helpers ------------------------------------------------------

const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
export const starToNumber = (s) => STAR[s] || 0;

export function formatAddress(a = {}) {
  return [...(a.addressLines || []), a.locality, a.administrativeArea, a.postalCode].filter(Boolean).join(', ');
}

const DAY_ENUM = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const toTime = (hhmm) => {
  const [hours, minutes] = String(hhmm || '00:00').split(':').map(Number);
  return { hours, minutes };
};
const fromTime = (t = {}) => `${String(t.hours ?? 0).padStart(2, '0')}:${String(t.minutes ?? 0).padStart(2, '0')}`;

export function hoursToGoogle(hours = []) {
  return {
    periods: hours
      .filter((h) => !h.closed)
      .map((h) => {
        const day = h.day.toUpperCase();
        return { openDay: day, openTime: toTime(h.open), closeDay: day, closeTime: toTime(h.close) };
      }),
  };
}

export function hoursFromGoogle(regularHours) {
  const periods = regularHours?.periods || [];
  return DAY_ENUM.map((D) => {
    const p = periods.find((x) => x.openDay === D);
    return p ? { day: D.toLowerCase(), open: fromTime(p.openTime), close: fromTime(p.closeTime), closed: false } : { day: D.toLowerCase(), open: '10:00', close: '20:00', closed: true };
  });
}
