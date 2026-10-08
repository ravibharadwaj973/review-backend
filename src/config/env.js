import 'dotenv/config';
import crypto from 'node:crypto';

const isProd = process.env.NODE_ENV === 'production';

function required(name, devFallback) {
  const value = process.env[name];
  if (value) return value;
  if (isProd && devFallback === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return devFallback;
}

// A stable dev secret so tokens survive restarts locally. In production you must set your own.
const DEV_SECRET = 'starling-dev-secret-change-me-in-production-0123456789';

const urlList = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

/**
 * FRONTEND_URL is the one setting that connects the API to the website.
 *   FRONTEND_URL=https://google.jharavi.in
 * Several are allowed (comma separated); the first is the public address used in
 * review links, QR codes and Google sign-in. A wildcard like https://*.vercel.app
 * also allows Vercel preview deployments. APP_URL is accepted as an older alias.
 */
const frontendUrls = urlList(process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000');
const devOrigins = isProd ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000'];
const publicFrontend = frontendUrls.find((u) => !u.includes('*')) || 'http://localhost:3000';

/**
 * ADMIN_URL is the address of the separate admin website, e.g. https://admin.jharavi.in
 * (comma separate several). It is allowed to call the API, and it is where
 * "Back to admin" returns to after an admin opens a business.
 */
const adminUrls = urlList(process.env.ADMIN_URL || (isProd ? '' : 'http://localhost:3001'));

export const env = {
  isProd,
  // Platform admins (comma separated). They see the /admin section.
  adminEmails: [...new Set([...String(process.env.ADMIN_EMAILS || '').split(','), process.env.ADMIN_EMAIL || ''].map((e) => e.trim().toLowerCase()).filter(Boolean))],
  // The main admin login, kept in sync from .env on every start (see utils/admin-from-env.js)
  admin: {
    email: String(process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD || '',
    name: String(process.env.ADMIN_NAME || '').trim(),
  },
  port: Number(process.env.PORT || 4000),
  frontendUrls,
  appUrl: publicFrontend,
  apiUrl: (process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, ''),
  // Public base URL Google can reach to fetch photos (must be https + publicly reachable)
  publicAssetUrl: (process.env.PUBLIC_ASSET_URL || publicFrontend).replace(/\/$/, ''),
  // Websites allowed to call the API from the browser
  adminUrls,
  adminUrl: adminUrls.find((u) => !u.includes('*')) || '',
  corsOrigins: [...new Set([...frontendUrls, ...adminUrls, ...urlList(process.env.CORS_ORIGINS), ...devOrigins])],

  mongoUri: process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL || '',
  embeddedMongoPath: process.env.EMBEDDED_MONGO_PATH || '.data/db',

  jwtSecret: required('JWT_SECRET', DEV_SECRET),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  // 32-byte key (hex or any string, hashed to 32 bytes) used to encrypt Google OAuth tokens at rest
  encryptionKey: crypto
    .createHash('sha256')
    .update(required('ENCRYPTION_KEY', DEV_SECRET))
    .digest(),

  groq: {
    // GROQ_URI is accepted as an alias because some setups store the key under that name
    apiKey: process.env.GROQ_API_KEY || process.env.GROQ_URI || '',
    // Groq retired the Llama 3.x models on 16 Aug 2026; gpt-oss is their recommended replacement
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    fastModel: process.env.GROQ_FAST_MODEL || 'openai/gpt-oss-20b',
    baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    // Defaults to the web app origin: Next.js forwards /api/* to this server, so one public URL is enough.
    redirectUri: process.env.GOOGLE_REDIRECT_URI || `${publicFrontend}/api/google/oauth/callback`,
  },

  worker: {
    inProcess: (process.env.RUN_WORKER ?? 'true') !== 'false',
    reviewSyncCron: process.env.REVIEW_SYNC_CRON || '*/15 * * * *',
    // Autopilot: auto replies, weekly photos and posts, seasonal hours
    autopilotCron: process.env.AUTOPILOT_CRON || '*/5 * * * *',
  },

  uploadDir: process.env.UPLOAD_DIR || 'uploads',
};

export const googleConfigured = () => Boolean(env.google.clientId && env.google.clientSecret);
export const groqConfigured = () => Boolean(env.groq.apiKey);

const originMatches = (list, origin) => {
  const o = origin.replace(/\/+$/, '');
  return list.some((allowed) => {
    if (!allowed.includes('*')) return allowed === o;
    const rx = new RegExp(`^${allowed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`, 'i');
    return rx.test(o);
  });
};

/** True when a browser Origin is allowed by FRONTEND_URL / ADMIN_URL / CORS_ORIGINS (supports * wildcards). */
export function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server, curl, the Vercel proxy
  return originMatches(env.corsOrigins, origin);
}

/** True when a full URL belongs to the admin website in ADMIN_URL. */
export function isAdminUrl(url) {
  try {
    return originMatches(env.adminUrls, new URL(url).origin);
  } catch {
    return false;
  }
}
