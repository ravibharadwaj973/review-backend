import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
  business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  placeId: String,
  center: { latitude: Number, longitude: Number },
  coordinateSource: { type: String, enum: ['owner', 'google'], default: 'owner' },
  keywords: [String],
  language: { type: String, default: 'en' },
}, { timestamps: true });
export const MapTracking = mongoose.model('MapTracking', settingsSchema, 'mapTracking');

const resultSchema = new mongoose.Schema({
  position: Number, placeId: String, title: String, address: String, rating: Number,
}, { _id: false });
const pointSchema = new mongoose.Schema({
  index: Number, row: Number, column: Number, latitude: Number, longitude: Number,
  status: { type: String, enum: ['pending', 'checked', 'error'], default: 'pending' },
  rank: Number, checkedAt: Date, error: String, searchId: String, results: [resultSchema],
}, { _id: false });
const scanSchema = new mongoose.Schema({
  business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  businessName: String, placeId: String, keyword: String,
  center: { latitude: Number, longitude: Number },
  radiusKm: Number, gridSize: Number, rankingRange: Number, language: String,
  provider: { type: String, default: 'serpapi' },
  signature: String,
  geoDataExpiresAt: Date,
  status: { type: String, enum: ['queued', 'running', 'complete', 'partial', 'failed', 'cancelled'], default: 'queued' },
  active: { type: Boolean, default: true },
  leaseUntil: Date, startedAt: Date, completedAt: Date, error: String,
  points: [pointSchema],
  summary: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
scanSchema.index({ business: 1, createdAt: -1 });
scanSchema.index({ geoDataExpiresAt: 1 }, { expireAfterSeconds: 0 });
scanSchema.index({ business: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
scanSchema.index({ active: 1, status: 1, createdAt: 1 });
export const MapScan = mongoose.model('MapScan', scanSchema, 'mapScans');
