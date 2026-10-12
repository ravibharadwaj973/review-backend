import { MapScan, Business } from '../../models/index.js';
import { metrics } from './metrics.js';
import { searchPoint } from './provider.js';

let running = false;
export async function runMapScans() {
  if (running) return;
  running = true;
  try {
    // Interrupted paid requests are never automatically repeated.
    await MapScan.updateMany({ status: 'running', active: true, leaseUntil: { $lt: new Date() } }, { $set: { active: false, status: 'failed', completedAt: new Date(), error: 'Scan interrupted. Remaining points are unknown. Start a new scan explicitly to retry.' } });
    for (let count = 0; count < 5; count++) {
      const scan = await MapScan.findOneAndUpdate({ status: 'queued', active: true }, { $set: { status: 'running', startedAt: new Date(), leaseUntil: new Date(Date.now() + 120000) } }, { sort: { createdAt: 1 }, new: true });
      if (!scan) break;
      try {
        for (const point of scan.points) {
          if (scan.geoDataExpiresAt && scan.geoDataExpiresAt <= new Date()) throw new Error('Google-derived coordinates expired. Refresh the location before starting a new scan.');
          const state = await MapScan.findById(scan._id).select('active').lean();
          if (!state?.active) break;
          const business = await Business.findById(scan.business).select('account.status').lean();
          if (!business || business.account?.status === 'suspended') throw new Error('Business is unavailable or paused.');
          try { Object.assign(point, await searchPoint(scan, point)); } catch (err) {
            point.status = 'error'; point.error = err.message; point.checkedAt = new Date();
            // Stop on the first provider error to avoid spending credits on repeated failures.
            scan.error = err.message;
          }
          const updated = await MapScan.updateOne({ _id: scan._id, active: true, status: 'running' }, { $set: { points: scan.points, leaseUntil: new Date(Date.now() + 120000) } });
          if (!updated.modifiedCount || point.status === 'error') break;
        }
        scan.summary = metrics(scan.points, scan.rankingRange);
        const status = scan.summary.checked === scan.points.length ? 'complete' : scan.summary.checked ? 'partial' : 'failed';
        await MapScan.updateOne({ _id: scan._id, active: true, status: 'running' }, { $set: { status, active: false, summary: scan.summary, completedAt: new Date(), error: scan.error } });
      } catch (err) {
        await MapScan.updateOne({ _id: scan._id, active: true }, { $set: { active: false, status: 'failed', completedAt: new Date(), error: err.message } });
      }
    }
  } catch (err) { console.error('[worker] map scan failed:', err.message); } finally { running = false; }
}
