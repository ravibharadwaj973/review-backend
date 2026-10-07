import mongoose from 'mongoose';

/**
 * A Google Business Profile post ("update", offer or event).
 * Lifecycle: draft → scheduled → published (or failed / discarded).
 */
export const POST_TYPES = ['STANDARD', 'OFFER', 'EVENT'];
export const POST_ACTIONS = ['NONE', 'BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'];
export const POST_THEMES = ['service', 'tip', 'reviews', 'team', 'faq', 'festival', 'custom'];

const postSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    type: { type: String, enum: POST_TYPES, default: 'STANDARD' },
    theme: { type: String, enum: POST_THEMES, default: 'custom' },
    summary: { type: String, required: true, maxlength: 1500 },
    title: { type: String, default: '', maxlength: 58 }, // event / offer title
    startDate: String, // YYYY-MM-DD (event / offer)
    endDate: String,
    couponCode: { type: String, default: '' },
    redeemUrl: { type: String, default: '' },
    terms: { type: String, default: '' },
    action: { type: String, enum: POST_ACTIONS, default: 'NONE' },
    actionUrl: { type: String, default: '' },
    photo: { type: mongoose.Schema.Types.ObjectId, ref: 'Photo' },
    status: { type: String, enum: ['draft', 'scheduled', 'published', 'failed', 'discarded'], default: 'draft', index: true },
    scheduledFor: Date,
    publishedAt: Date,
    publishedTo: { type: String, enum: ['google', 'demo'] },
    source: { type: String, enum: ['ai', 'manual'], default: 'manual' },
    model: String,
    // For posts the weekly planner created: one per slot, so a discarded draft isn't recreated
    slotKey: { type: String, index: true },
    featured: String, // service or question this post is about (helps rotate topics)
    google: { name: String, searchUrl: String, state: String },
    error: String,
  },
  { timestamps: true }
);

postSchema.index({ business: 1, slotKey: 1 });

export const Post = mongoose.model('Post', postSchema, 'posts');
