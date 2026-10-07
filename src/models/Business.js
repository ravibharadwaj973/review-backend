import mongoose from 'mongoose';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const hoursSchema = new mongoose.Schema(
  {
    day: { type: String, enum: DAYS, required: true },
    open: { type: String, default: '10:00' }, // HH:mm
    close: { type: String, default: '20:00' },
    closed: { type: Boolean, default: false },
  },
  { _id: false }
);

const specialHoursSchema = new mongoose.Schema(
  {
    date: { type: String, required: true }, // YYYY-MM-DD
    open: String,
    close: String,
    closed: { type: Boolean, default: true },
    note: String,
  },
  { _id: true }
);

const staffSchema = new mongoose.Schema({ name: String, role: String }, { _id: true });

const businessSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, default: 'Salon', trim: true },
    description: { type: String, default: '', maxlength: 750 }, // Google limit is 750 chars
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    address: {
      line1: { type: String, default: '' },
      line2: { type: String, default: '' },
      city: { type: String, default: '' },
      state: { type: String, default: '' },
      postalCode: { type: String, default: '' },
      country: { type: String, default: 'IN' },
    },
    hours: {
      type: [hoursSchema],
      default: () => DAYS.map((day) => ({ day, open: '10:00', close: '20:00', closed: false })),
    },
    specialHours: [specialHoursSchema],
    serviceAreas: [String],
    links: {
      website: { type: String, default: '' },
      booking: { type: String, default: '' },
      appointment: { type: String, default: '' },
      ordering: { type: String, default: '' },
      whatsapp: { type: String, default: '' },
      instagram: { type: String, default: '' },
      facebook: { type: String, default: '' },
      youtube: { type: String, default: '' },
    },
    policies: { type: String, default: '' },
    staff: [staffSchema],
    logoUrl: { type: String, default: '' },
    currency: { type: String, default: 'INR' },
    timezone: { type: String, default: 'Asia/Kolkata' },

    // How AI writes on the business's behalf
    voice: {
      tone: { type: String, enum: ['warm', 'professional', 'playful', 'concise'], default: 'warm' },
      signOff: { type: String, default: '' },
      language: { type: String, default: 'English' },
      avoid: { type: String, default: '' }, // phrases/topics to avoid
    },

    // Review-request + automation preferences
    automation: {
      requestDelayHours: { type: Number, default: 2, min: 0, max: 720 },
      autoAnalyze: { type: Boolean, default: true },
      autoDraftReplies: { type: Boolean, default: true },
      // Older setting, kept for existing data. Reply rules below replace it.
      autoPublishFiveStar: { type: Boolean, default: false },
      // What happens to the AI reply for each star rating:
      //   auto    — AI posts it by itself after replyDelayMinutes (you can still edit or hold it)
      //   approve — AI drafts it and waits for you
      replyRules: {
        five: { type: String, enum: ['auto', 'approve'], default: 'auto' },
        four: { type: String, enum: ['auto', 'approve'], default: 'auto' },
        three: { type: String, enum: ['auto', 'approve'], default: 'approve' },
        low: { type: String, enum: ['auto', 'approve'], default: 'approve' }, // 1–2 stars
      },
      replyDelayMinutes: { type: Number, default: 30, min: 0, max: 1440 },
      // Push hours / holiday hours to Google as soon as they are saved
      syncHoursToGoogle: { type: Boolean, default: true },
    },

    // Weekly autopilot that keeps the Google profile active
    autopilot: {
      photos: {
        enabled: { type: Boolean, default: true },
        perWeek: { type: Number, default: 4, min: 0, max: 7 },
        autoQueueUploads: { type: Boolean, default: true }, // new uploads join the queue
      },
      posts: {
        enabled: { type: Boolean, default: true },
        perWeek: { type: Number, default: 1, min: 0, max: 3 },
        autoPublish: { type: Boolean, default: false }, // false = AI drafts wait for approval
        day: { type: String, enum: DAYS, default: 'tuesday' },
        time: { type: String, default: '11:00' },
      },
    },

    // Different weekly hours for part of the year (e.g. summer timings). Applied automatically.
    seasonalHours: [
      new mongoose.Schema(
        {
          name: { type: String, default: 'Seasonal hours' },
          start: { type: String, required: true }, // YYYY-MM-DD
          end: { type: String, required: true },
          hours: [hoursSchema],
        },
        { _id: true }
      ),
    ],
    // Fingerprint of the weekly hours last sent to Google (so season changes are pushed once)
    googleHoursSig: String,

    // Fallback review link when no Google location is connected
    reviewLink: { type: String, default: '' },

    // Public short link behind the business QR code: APP_URL/b/<slug>
    slug: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
    qrStats: {
      opens: { type: Number, default: 0 }, // QR page opened (scan or shared link)
      composed: { type: Number, default: 0 }, // customer used the writing helper
      clicks: { type: Number, default: 0 }, // went on to Google's review form
      submitted: { type: Number, default: 0 }, // reviews submitted in Starling
      lastOpenAt: Date,
    },
    onboarding: {
      profile: { type: Boolean, default: false },
      services: { type: Boolean, default: false },
      google: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

businessSchema.statics.DAYS = DAYS;

const slugify = (name = '') =>
  name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'business';

/** Gives the business a unique public slug if it doesn't have one yet. */
businessSchema.methods.ensureSlug = async function ensureSlug() {
  if (this.slug) return this.slug;
  const base = slugify(this.name);
  let candidate = base;
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const taken = await this.constructor.exists({ slug: candidate, _id: { $ne: this._id } });
    if (!taken) break;
    candidate = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  this.slug = candidate;
  await this.save();
  return this.slug;
};
businessSchema.statics.slugify = slugify;

export const Business = mongoose.model('Business', businessSchema, 'businesses');
