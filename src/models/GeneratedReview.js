import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  reviewRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ReviewRequest' },
  source: { type: String, enum: ['link', 'qr'], required: true },
  text: { type: String, trim: true, required: true, maxlength: 1500 },
  model: { type: String, required: true, match: /^groq:/ },
  rating: { type: Number, required: true, min: 1, max: 5 },
  services: [{ type: String }],
}, { timestamps: true });

schema.index({ business: 1, createdAt: -1 });

export const GeneratedReview = mongoose.model('GeneratedReview', schema);
