import cron from 'node-cron';
import { env } from '../config/env.js';
import { syncAllBusinesses } from '../modules/google/sync.js';
import { runAutopilotAll } from '../modules/autopilot/runner.js';

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

/** Autopilot: posts due replies, photos and Google posts; plans the coming week; switches seasonal hours. */
export async function runAutopilot() {
  try {
    await runAutopilotAll();
  } catch (err) {
    console.error('[worker] autopilot failed:', err.message);
  }
}

export function startScheduler() {
  const tasks = [];
  if (cron.validate(env.worker.reviewSyncCron)) {
    tasks.push(cron.schedule(env.worker.reviewSyncCron, runReviewSync));
    console.log(`[worker] review monitoring scheduled (${env.worker.reviewSyncCron})`);
    setTimeout(runReviewSync, 10_000);
  } else {
    console.warn(`[worker] invalid REVIEW_SYNC_CRON "${env.worker.reviewSyncCron}", review sync disabled`);
  }
  if (cron.validate(env.worker.autopilotCron)) {
    tasks.push(cron.schedule(env.worker.autopilotCron, runAutopilot));
    console.log(`[worker] autopilot scheduled (${env.worker.autopilotCron})`);
    setTimeout(runAutopilot, 20_000);
  } else {
    console.warn(`[worker] invalid AUTOPILOT_CRON "${env.worker.autopilotCron}", autopilot disabled`);
  }
  return () => tasks.forEach((t) => t.stop());
}
