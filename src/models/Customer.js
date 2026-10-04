import mongoose from 'mongoose';

const visitSchema = new mongoose.Schema(
  {
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
    serviceName: String,
    date: { type: Date, default: Date.now },
    amount: Number,
  },
  { _id: true }
);

const customerSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    visits: [visitSchema],
    lastVisit: Date,
    notes: { type: String, default: '' },
    tags: [String],
    consent: { type: Boolean, default: true }, // customer agreed to be contacted
    reviewStatus: { type: String, enum: ['none', 'requested', 'clicked', 'reviewed'], default: 'none' },
    lastRequestedAt: Date,
    googleReview: { type: mongoose.Schema.Types.ObjectId, ref: 'Review' },
  },
  { timestamps: true }
);

customerSchema.index({ business: 1, name: 1 });
customerSchema.index({ business: 1, phone: 1 });

customerSchema.pre('save', function updateLastVisit(next) {
  if (this.visits?.length) {
    this.lastVisit = this.visits.reduce((max, v) => (v.date > max ? v.date : max), this.visits[0].date);
  }
  next();
});

export const Customer = mongoose.model('Customer', customerSchema, 'customers');
