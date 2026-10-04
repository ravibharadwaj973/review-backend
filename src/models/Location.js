import mongoose from 'mongoose';

/** A physical branch. MVP uses one location per business; the schema supports many. */
const locationSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    title: { type: String, required: true },
    address: String,
    isPrimary: { type: Boolean, default: true },
    google: {
      accountName: String, // accounts/123
      locationName: String, // locations/456
      placeId: String,
      newReviewUri: String,
      mapsUri: String,
      primaryCategory: String, // categories/gcid:beauty_salon
    },
    lastSyncedAt: Date,
  },
  { timestamps: true }
);

export const Location = mongoose.model('Location', locationSchema, 'businessLocations');
