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
 *   FRONTEND_URL=https://starling.vercel.app
 * Several are allowed (comma separated); the first is the public address used in
 * review links, QR codes and Google sign-in. A wildcard like https://*.vercel.app
 * also allows Vercel preview deployments. APP_URL is accepted as an older alias.
 */
const frontendUrls = urlList(process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000');
const devOrigins = isProd ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000'];
const publicFrontend = frontendUrls.find((u) => !u.includes('*')) || 'http://localhost:3000';

export const env = {
  isProd,
  port: Number(process.env.PORT || 4000),
  frontendUrls,
  appUrl: publicFrontend,
  apiUrl: (process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, ''),
  // Public base URL Google can reach to fetch photos (must be https + publicly reachable)
  publicAssetUrl: (process.env.PUBLIC_ASSET_URL || publicFrontend).replace(/\/$/, ''),
  // Websites allowed to call the API from the browser
  corsOrigins: [...new Set([...frontendUrls, ...urlList(process.env.CORS_ORIGINS), ...devOrigins])],

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
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    fastModel: process.env.GROQ_FAST_MODEL || 'llama-3.1-8b-instant',
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
  },

  uploadDir: process.env.UPLOAD_DIR || 'uploads',
};

export const googleConfigured = () => Boolean(env.google.clientId && env.google.clientSecret);
export const groqConfigured = () => Boolean(env.groq.apiKey);

/** True when a browser Origin is allowed by FRONTEND_URL / CORS_ORIGINS (supports * wildcards). */
export function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server, curl, the Vercel proxy
  const o = origin.replace(/\/+$/, '');
  return env.corsOrigins.some((allowed) => {
    if (!allowed.includes('*')) return allowed === o;
    const rx = new RegExp(`^${allowed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`, 'i');
    return rx.test(o);
  });
}
