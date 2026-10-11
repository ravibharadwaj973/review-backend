import mongoose from 'mongoose';
import { encrypt, decrypt } from '../utils/crypto.js';

/**
 * A connected Google Business Profile. Tokens are encrypted at rest (AES-256-GCM).
 * mode = 'live' for a real OAuth connection, 'demo' for the built-in sandbox.
 */
const googleAccountSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
    mode: { type: String, enum: ['live', 'demo'], required: true },
    email: String,
    accessTokenEnc: { type: String, select: false },
    refreshTokenEnc: { type: String, select: false },
    expiresAt: Date,
    scope: String,
    accountName: String, // accounts/123
    locationName: String, // locations/456
    locationTitle: String,
    status: { type: String, enum: ['connected', 'needs_location', 'error', 'revoked'], default: 'connected' },
    lastSyncAt: Date,
    lastError: String,
    locationInventory: mongoose.Schema.Types.Mixed,
    locationsFetchedAt: Date,
    // snapshot of what Google currently shows, for the sync-status comparison
    remote: {
      title: String,
      phone: String,
      website: String,
      description: String,
      address: String,
      latlng: mongoose.Schema.Types.Mixed,
      serviceArea: mongoose.Schema.Types.Mixed,
      openInfo: mongoose.Schema.Types.Mixed,
      mapsUri: String,
      hours: mongoose.Schema.Types.Mixed,
      serviceCount: Number,
      specialCount: Number,
      photoCount: Number,
      fetchedAt: Date,
      categories: mongoose.Schema.Types.Mixed,
      serviceNames: [String],
      attributes: mongoose.Schema.Types.Mixed,
      attributeError: String,
      verification: mongoose.Schema.Types.Mixed,
      verificationError: String,
      searchKeywords: mongoose.Schema.Types.Mixed,
      searchKeywordError: String,
      searchMonth: String,
    },
  },
  { timestamps: true }
);

googleAccountSchema.methods.setTokens = function setTokens({ access_token, refresh_token, expires_in, scope }) {
  if (access_token) this.accessTokenEnc = encrypt(access_token);
  if (refresh_token) this.refreshTokenEnc = encrypt(refresh_token);
  if (expires_in) this.expiresAt = new Date(Date.now() + (expires_in - 60) * 1000);
  if (scope) this.scope = scope;
};
googleAccountSchema.methods.getAccessToken = function getAccessToken() {
  return decrypt(this.accessTokenEnc);
};
googleAccountSchema.methods.getRefreshToken = function getRefreshToken() {
  return decrypt(this.refreshTokenEnc);
};
googleAccountSchema.methods.toJSON = function toJSON() {
  const o = this.toObject();
  delete o.accessTokenEnc;
  delete o.refreshTokenEnc;
  return o;
};

export const GoogleAccount = mongoose.model('GoogleAccount', googleAccountSchema, 'googleAccounts');
