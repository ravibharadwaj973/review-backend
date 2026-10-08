import mongoose from 'mongoose';

const analysisSchema = new mongoose.Schema(
  {
    sentiment: { type: String, enum: ['positive', 'neutral', 'negative', 'mixed'] },
    score: Number, // -1..1
    services: [String],
    positives: [String],
    negatives: [String],
    concerns: [String],
    keywords: [String],
    urgency: { type: String, enum: ['low', 'medium', 'high'] },
    recommendation: String,
    model: String,
    analyzedAt: Date,
  },
  { _id: false }
);

const reviewSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location' },
    // google = imported from Google, demo = sandbox, direct = submitted by the customer in ReviewRankr (no login)
    source: { type: String, enum: ['google', 'demo', 'direct'], default: 'google' },
    submittedVia: { type: String, enum: ['link', 'qr'] }, // for direct reviews
    services: [String], // services the customer said they took (direct reviews)
    googleReviewName: String, // accounts/x/locations/y/reviews/z
    googleReviewId: { type: String, required: true },
    reviewer: {
      name: { type: String, default: 'Google user' },
      photoUrl: String,
      isAnonymous: Boolean,
    },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, default: '' },
    createTime: { type: Date, required: true, index: true },
    updateTime: Date,
    reply: {
      comment: String,
      updateTime: Date,
      by: { type: String, enum: ['google', 'app'] },
    },
    status: { type: String, enum: ['unanswered', 'drafted', 'answered'], default: 'unanswered', index: true },
    analysis: analysisSchema,
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    reviewRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ReviewRequest' },
    firstSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

reviewSchema.index({ business: 1, googleReviewId: 1 }, { unique: true });

reviewSchema.virtual('sentimentBucket').get(function bucket() {
  if (this.rating >= 4) return 'positive';
  if (this.rating === 3) return 'neutral';
  return 'negative';
});

export const Review = mongoose.model('Review', reviewSchema, 'reviews');
