import cron from 'node-cron';
import { env } from '../config/env.js';
import { syncAllBusinesses } from '../modules/google/sync.js';

let running = false;

/** Review monitoring: pulls new Google reviews and runs analysis + reply drafting. */
export async function runReviewSync() {
  if (running) return;
  running = true;
  const started = Date.now();
  try {
    const { accounts, created } = await syncAllBusinesses();
    if (accounts) console.log(`[worker] synced ${accounts} profile(s), ${created} new review(s) in ${Date.now() - started}ms`);
  } catch (err) {
    console.error('[worker] review sync failed:', err.message);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  if (!cron.validate(env.worker.reviewSyncCron)) {
    console.warn(`[worker] invalid REVIEW_SYNC_CRON "${env.worker.reviewSyncCron}", scheduler disabled`);
    return () => {};
  }
  const task = cron.schedule(env.worker.reviewSyncCron, runReviewSync);
  console.log(`[worker] review monitoring scheduled (${env.worker.reviewSyncCron})`);
  setTimeout(runReviewSync, 10_000);
  return () => task.stop();
}
