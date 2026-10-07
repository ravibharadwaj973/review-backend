import mongoose from 'mongoose';

/** An AI-drafted reply. Lifecycle: draft → approved → published (or discarded). */
const aiResponseSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    review: { type: mongoose.Schema.Types.ObjectId, ref: 'Review', required: true, index: true },
    text: { type: String, required: true }, // what the AI wrote
    finalText: String, // what the owner approved (may be edited)
    edited: { type: Boolean, default: false },
    tone: String,
    model: String,
    status: { type: String, enum: ['draft', 'approved', 'published', 'discarded', 'failed'], default: 'draft' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    publishedAt: Date,
    publishedTo: { type: String, enum: ['google', 'demo', 'app'] },
    error: String,
    // Set when a reply rule says "post automatically": the worker publishes it at this time
    autoPublishAt: Date,
  },
  { timestamps: true }
);

export const AiResponse = mongoose.model('AiResponse', aiResponseSchema, 'aiResponses');
