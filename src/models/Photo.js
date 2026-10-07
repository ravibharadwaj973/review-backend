import mongoose from 'mongoose';

export const PHOTO_CATEGORIES = [
  'logo', 'cover', 'interior', 'exterior', 'team', 'services', 'products', 'before_after', 'events', 'other',
];

// Our categories → Google Business Profile media categories
export const GOOGLE_MEDIA_CATEGORY = {
  logo: 'LOGO',
  cover: 'COVER',
  interior: 'INTERIOR',
  exterior: 'EXTERIOR',
  team: 'TEAMS',
  services: 'AT_WORK',
  products: 'PRODUCT',
  before_after: 'ADDITIONAL',
  events: 'ADDITIONAL',
  other: 'ADDITIONAL',
};

const photoSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    category: { type: String, enum: PHOTO_CATEGORIES, default: 'other' },
    fileUrl: { type: String, required: true },
    fileName: String,
    mimeType: String,
    size: Number,
    caption: { type: String, default: '' },
    // Weekly photo schedule: queued photos are posted to Google a few per week
    queued: { type: Boolean, default: false, index: true },
    queuePosition: { type: Number, default: 0 },
    scheduledFor: Date, // next planned posting time (null = waiting for a free slot)
    postedAt: Date,
    google: {
      syncStatus: {
        type: String,
        enum: ['not_synced', 'pending', 'synced', 'failed', 'demo'],
        default: 'not_synced',
      },
      mediaName: String,
      syncedAt: Date,
      error: String,
    },
  },
  { timestamps: true }
);

export const Photo = mongoose.model('Photo', photoSchema, 'photos');
