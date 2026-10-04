import mongoose from 'mongoose';

const serviceSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', maxlength: 300 },
    category: { type: String, default: 'General', trim: true },
    price: { type: Number, min: 0 },
    duration: { type: Number, min: 0 }, // minutes
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    // Review topics a customer might choose to mention (optional prompts, never review text)
    reviewTopics: [String],
    google: {
      syncStatus: { type: String, enum: ['not_synced', 'synced', 'failed', 'demo'], default: 'not_synced' },
      syncedAt: Date,
      error: String,
    },
  },
  { timestamps: true }
);

serviceSchema.index({ business: 1, name: 1 });

export const Service = mongoose.model('Service', serviceSchema, 'services');
