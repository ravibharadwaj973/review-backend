import { env, googleConfigured, groqConfigured } from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import { createApp } from './app.js';
import { startScheduler } from './jobs/scheduler.js';
import { ensureAdminFromEnv } from './utils/admin-from-env.js';

async function main() {
  await connectDB();
  await ensureAdminFromEnv().catch((err) => console.warn('[admin] could not set up the admin login:', err.message));
  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[api] Starling API listening on http://localhost:${env.port}`);
    console.log(`[api] Frontend: ${env.appUrl}  (allowed origins: ${env.corsOrigins.join(', ')})`);
    console.log(`[api] Admin site: ${env.adminUrl || 'not set — add ADMIN_URL to .env (e.g. https://admin.yourdomain.in)'}`);
    if (env.isProd && /localhost|127\.0\.0\.1/.test(env.appUrl)) {
      console.warn('[api] FRONTEND_URL is still localhost — set it to your website address so links and QR codes work.');
    }
    console.log(`[api] AI: ${groqConfigured() ? `Groq (${env.groq.model})` : 'built-in fallback (set GROQ_API_KEY for Groq)'}`);
    console.log(`[api] Google Business Profile: ${googleConfigured() ? 'OAuth configured' : 'not configured — demo connection available'}`);
  });
  const stopScheduler = env.worker.inProcess ? startScheduler() : () => {};

  const shutdown = async (signal) => {
    console.log(`[api] ${signal} received, shutting down`);
    stopScheduler();
    server.close();
    await disconnectDB().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[api] failed to start:', err);
  process.exit(1);
});
