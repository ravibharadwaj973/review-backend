import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;
export const CYCLES = ['monthly', 'quarterly', 'half_yearly', 'yearly'];
export const PAYMENT_METHODS = ['upi', 'cash', 'bank_transfer', 'card', 'cheque', 'other'];

/** A subscription plan sold to businesses. */
const planSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, default: '', maxlength: 300 },
    price: { type: Number, required: true, min: 0 }, // per billing cycle, in rupees
    billingCycle: { type: String, enum: CYCLES, default: 'monthly' },
    features: [{ type: String, maxlength: 120 }],
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);
export const Plan = mongoose.model('Plan', planSchema, 'plans');

/** A bill for one period. Paid / balance are kept in sync from confirmed payments. */
const invoiceSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    business: { type: ObjectId, ref: 'Business', required: true, index: true },
    description: { type: String, default: '' },
    planName: String,
    periodStart: Date,
    periodEnd: Date,
    amount: { type: Number, required: true, min: 0 }, // actual price
    discount: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 }, // amount − discount
    paid: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'partial', 'paid', 'waived', 'cancelled'], default: 'pending', index: true },
    dueDate: Date,
    paidAt: Date,
    notes: { type: String, default: '' },
    createdBy: { type: String, enum: ['admin', 'system'], default: 'admin' },
  },
  { timestamps: true }
);
export const Invoice = mongoose.model('Invoice', invoiceSchema, 'invoices');

/**
 * A payment received outside the app (UPI, cash, bank…). Admins record confirmed payments;
 * a business can report one it made, which waits for an admin to verify it.
 */
const paymentSchema = new mongoose.Schema(
  {
    business: { type: ObjectId, ref: 'Business', required: true, index: true },
    amount: { type: Number, required: true, min: 1 },
    method: { type: String, enum: PAYMENT_METHODS, default: 'upi' },
    reference: { type: String, default: '', maxlength: 120 }, // UPI ref / cheque no. / receipt no.
    paidAt: { type: Date, default: Date.now },
    notes: { type: String, default: '', maxlength: 500 },
    status: { type: String, enum: ['confirmed', 'pending', 'rejected'], default: 'confirmed', index: true },
    submittedBy: { type: String, enum: ['admin', 'owner'], default: 'admin' },
    recordedBy: { type: ObjectId, ref: 'User' },
    verifiedAt: Date,
    preferredInvoice: { type: ObjectId, ref: 'Invoice' },
    // How the amount was applied to bills; anything left over is credit for the next bill
    allocations: [{ invoice: { type: ObjectId, ref: 'Invoice' }, amount: Number, _id: false }],
  },
  { timestamps: true }
);
export const Payment = mongoose.model('Payment', paymentSchema, 'payments');

/** Everything admins do to an account, for the activity history. */
const adminLogSchema = new mongoose.Schema(
  {
    admin: { type: ObjectId, ref: 'User' },
    business: { type: ObjectId, ref: 'Business', index: true },
    action: { type: String, required: true },
    details: mongoose.Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
export const AdminLog = mongoose.model('AdminLog', adminLogSchema, 'adminLogs');

/** Platform-wide settings (one document). */
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'platform', unique: true },
    companyName: { type: String, default: 'Starling' },
    currency: { type: String, default: 'INR' },
    upiId: { type: String, default: '' },
    bankDetails: { type: String, default: '' },
    paymentInstructions: { type: String, default: 'Pay by UPI or bank transfer, then send us the reference number.' },
    supportPhone: { type: String, default: '' },
    supportEmail: { type: String, default: '' },
    defaultTrialDays: { type: Number, default: 14, min: 0, max: 365 },
    invoiceDueDays: { type: Number, default: 7, min: 0, max: 90 },
    autoSuspendOverdueDays: { type: Number, default: 0, min: 0, max: 365 }, // 0 = never pause automatically
    invoiceCounter: { type: Number, default: 0 },
  },
  { timestamps: true }
);
settingSchema.statics.get = async function get() {
  return (await this.findOne({ key: 'platform' })) || this.create({ key: 'platform' });
};
export const Setting = mongoose.model('Setting', settingSchema, 'settings');
