import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  queryKey: { type: String, required: true },
  results: [{ placeId: String, latitude: Number, longitude: Number, address: String, locationType: String, partialMatch: Boolean, _id: false }],
  fetchedAt: Date,
  expiresAt: Date,
});
schema.index({ business: 1, queryKey: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const GeocodeCache = mongoose.model('GeocodeCache', schema, 'geocodeCache');
