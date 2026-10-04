import mongoose from 'mongoose';

const reviewRequestSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
    serviceName: String,
    visitDate: Date,
    channel: { type: String, enum: ['whatsapp', 'sms', 'email', 'copy'], default: 'whatsapp' },
    message: { type: String, required: true },
    model: String,
    token: { type: String, required: true, unique: true }, // public tracking link /r/:token
    topics: [String], // optional things the customer might mention
    status: { type: String, enum: ['draft', 'scheduled', 'sent', 'clicked', 'reviewed'], default: 'draft', index: true },
    scheduledFor: Date,
    sentAt: Date,
    openedAt: Date,
    clickedAt: Date,
    clicks: { type: Number, default: 0 },
    composeCount: { type: Number, default: 0 }, // times the customer used the writing helper
    reviewedAt: Date,
    review: { type: mongoose.Schema.Types.ObjectId, ref: 'Review' },
    attribution: { type: String, enum: ['name_match', 'manual', 'direct'] },
  },
  { timestamps: true }
);

export const ReviewRequest = mongoose.model('ReviewRequest', reviewRequestSchema, 'reviewRequests');
