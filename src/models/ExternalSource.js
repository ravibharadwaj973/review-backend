import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  url: { type: String, required: true },
  kind: { type: String, enum: ['directory', 'press', 'industry', 'community', 'other'], default: 'other' },
  provider: { type: String, default: 'Owner supplied' },
  providerReported: mongoose.Schema.Types.Mixed,
  status: { type: String, enum: ['unchecked', 'checking', 'checked', 'failed'], default: 'unchecked' },
  checkedAt: Date,
  checkStartedAt: Date,
  error: String,
  evidence: mongoose.Schema.Types.Mixed,
  previousEvidence: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
schema.index({ business: 1, url: 1 }, { unique: true });
export const ExternalSource = mongoose.model('ExternalSource', schema, 'externalSources');
