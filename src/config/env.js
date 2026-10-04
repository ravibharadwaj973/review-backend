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

export const env = {
  isProd,
  port: Number(process.env.PORT || 4000),
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  apiUrl: (process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, ''),
  // Public base URL Google can reach to fetch photos (must be https + publicly reachable)
  publicAssetUrl: (process.env.PUBLIC_ASSET_URL || process.env.APP_URL || '').replace(/\/$/, ''),
  corsOrigins: (process.env.CORS_ORIGINS || process.env.APP_URL || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

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
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ||
      `${(process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')}/api/google/oauth/callback`,
  },

  worker: {
    inProcess: (process.env.RUN_WORKER ?? 'true') !== 'false',
    reviewSyncCron: process.env.REVIEW_SYNC_CRON || '*/15 * * * *',
  },

  uploadDir: process.env.UPLOAD_DIR || 'uploads',
};

export const googleConfigured = () => Boolean(env.google.clientId && env.google.clientSecret);
export const groqConfigured = () => Boolean(env.groq.apiKey);
