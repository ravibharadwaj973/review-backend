/**
 * Standalone worker process (used in Docker / production so the API can scale separately).
 * Run with RUN_WORKER=false on the API when this process is used.
 */
import { connectDB, disconnectDB } from '../config/db.js';
import { startScheduler } from './scheduler.js';

await connectDB();
const stop = startScheduler();
console.log('[worker] started');

const shutdown = async () => {
  stop();
  await disconnectDB().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
