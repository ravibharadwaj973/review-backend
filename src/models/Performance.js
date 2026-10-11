import mongoose from 'mongoose';

const snapshotSchema = new mongoose.Schema({
  business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  locationName: { type: String, required: true },
  start: String, end: String, fetchedAt: Date,
  series: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
snapshotSchema.index({ business: 1, locationName: 1, start: 1, end: 1 }, { unique: true });
export const PerformanceSnapshot = mongoose.model('PerformanceSnapshot', snapshotSchema, 'performanceSnapshots');

const activitySchema = new mongoose.Schema({
  business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  locationName: { type: String, required: true },
  title: { type: String, required: true, maxlength: 160 },
  kind: { type: String, enum: ['profile', 'website', 'directory', 'community', 'other'], default: 'other' },
  completedAt: { type: Date, required: true },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  source: { type: String, enum: ['google', 'owner'], default: 'owner' },
}, { timestamps: true });
export const CompletedActivity = mongoose.model('CompletedActivity', activitySchema, 'completedActivities');
