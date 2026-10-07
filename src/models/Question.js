import mongoose from 'mongoose';

/**
 * Questions customers ask, with the owner's answers. Answers feed the AI (replies, posts)
 * and can be shared as Google posts. Google's Q&A API was shut down in November 2025,
 * so these are not pushed to a Q&A section.
 */
const questionSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    question: { type: String, required: true, trim: true, maxlength: 300 },
    answer: { type: String, default: '', maxlength: 1500 },
    status: { type: String, enum: ['suggested', 'answered', 'dismissed'], default: 'suggested', index: true },
    source: { type: String, enum: ['ai', 'reviews', 'manual'], default: 'manual' },
    needsInput: { type: Boolean, default: false }, // AI couldn't answer from the profile — owner should fill it
    aiDrafted: { type: Boolean, default: false },
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
  },
  { timestamps: true }
);

export const Question = mongoose.model('Question', questionSchema, 'questions');
