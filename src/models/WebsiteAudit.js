import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  url: String,
  status: { type: String, enum: ['running', 'completed', 'failed'], required: true },
  startedAt: Date,
  completedAt: Date,
  error: String,
  report: mongoose.Schema.Types.Mixed,
  previousSummary: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

export const WebsiteAudit = mongoose.model('WebsiteAudit', schema, 'websiteAudits');
