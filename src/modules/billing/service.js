import { Business, Invoice, Payment, Plan, Setting, AdminLog } from '../../models/index.js';

export const CYCLE_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
export const CYCLE_LABEL = { monthly: 'Monthly', quarterly: 'Every 3 months', half_yearly: 'Every 6 months', yearly: 'Yearly' };

const round = (n) => Math.round(Number(n || 0) * 100) / 100;
const plain = (v) => (v?.toObject ? v.toObject() : v || {});

export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0); // 31 Jan + 1 month → 28/29 Feb
  return d;
}

/** Price per cycle for an account: custom price, else the plan's price. */
export function listPrice(account, plan) {
  if (account?.price != null) return round(account.price);
  return round(plan?.price || 0);
}

export function discountFor(account, amount) {
  if (!account || account.discountType === 'none' || !account.discountValue) return 0;
  const d = account.discountType === 'percent' ? (amount * Math.min(100, account.discountValue)) / 100 : account.discountValue;
  return round(Math.min(amount, d));
}

async function nextInvoiceNumber() {
  const s = await Setting.findOneAndUpdate({ key: 'platform' }, { $inc: { invoiceCounter: 1 } }, { new: true, upsert: true });
  return `INV-${new Date().getFullYear()}-${String(s.invoiceCounter).padStart(4, '0')}`;
}

export async function log(adminId, businessId, action, details) {
  await AdminLog.create({ admin: adminId, business: businessId, action, details }).catch(() => {});
}

/** Recomputes paid / balance / status of an invoice from confirmed payment allocations. */
export async function recalcInvoice(invoice) {
  const payments = await Payment.find({ 'allocations.invoice': invoice._id, status: 'confirmed' }).lean();
  const paid = round(payments.reduce((sum, p) => sum + (p.allocations || []).filter((a) => String(a.invoice) === String(invoice._id)).reduce((s, a) => s + a.amount, 0), 0));
  invoice.paid = paid;
  if (!['waived', 'cancelled'].includes(invoice.status)) {
    invoice.balance = round(Math.max(0, invoice.total - paid));
    invoice.status = invoice.balance <= 0 ? 'paid' : paid > 0 ? 'partial' : 'pending';
    invoice.paidAt = invoice.status === 'paid' ? invoice.paidAt || new Date() : undefined;
  } else {
    invoice.balance = 0;
  }
  await invoice.save();
  return invoice;
}

/** Applies a confirmed payment's unallocated amount to open bills, oldest first (or the chosen bill first). */
export async function allocatePayment(payment) {
  if (payment.status !== 'confirmed') return payment;
  let remaining = round(payment.amount - (payment.allocations || []).reduce((s, a) => s + a.amount, 0));
  if (remaining <= 0) return payment;
  const open = await Invoice.find({ business: payment.business, status: { $in: ['pending', 'partial'] } }).sort({ dueDate: 1, createdAt: 1 });
  if (payment.preferredInvoice) open.sort((a, b) => (String(a._id) === String(payment.preferredInvoice) ? -1 : String(b._id) === String(payment.preferredInvoice) ? 1 : 0));
  const touched = [];
  for (const inv of open) {
    if (remaining <= 0) break;
    await recalcInvoice(inv);
    if (inv.balance <= 0) continue;
    const take = round(Math.min(inv.balance, remaining));
    const existing = payment.allocations.find((a) => String(a.invoice) === String(inv._id));
    if (existing) existing.amount = round(existing.amount + take);
    else payment.allocations.push({ invoice: inv._id, amount: take });
    remaining = round(remaining - take);
    touched.push(inv);
  }
  payment.markModified('allocations');
  await payment.save();
  for (const inv of touched) await recalcInvoice(inv);
  return payment;
}

/** Leftover money from confirmed payments that isn't applied to any bill yet. */
export async function creditFor(businessId) {
  const payments = await Payment.find({ business: businessId, status: 'confirmed' }).lean();
  return round(payments.reduce((s, p) => s + p.amount - (p.allocations || []).reduce((x, a) => x + a.amount, 0), 0));
}

/** Uses any credit on the account to pay open bills. */
export async function applyCredit(businessId) {
  const payments = await Payment.find({ business: businessId, status: 'confirmed' });
  for (const p of payments) {
    const used = (p.allocations || []).reduce((x, a) => x + a.amount, 0);
    if (p.amount - used > 0) await allocatePayment(p);
  }
}

/** Keeps paidUntil in step with paid bills and lifts an automatic pause once nothing is overdue. */
export async function refreshAccount(businessOrId) {
  const business = typeof businessOrId?.save === 'function' ? businessOrId : await Business.findById(businessOrId);
  if (!business) return null;
  const covered = await Invoice.find({ business: business._id, status: { $in: ['paid', 'waived'] }, periodEnd: { $exists: true } }).sort({ periodEnd: -1 }).limit(1).lean();
  const paidUntil = covered[0]?.periodEnd || undefined;
  const acc = plain(business.account);
  let changed = String(acc.paidUntil || '') !== String(paidUntil || '');
  if (acc.status === 'suspended' && acc.suspendedBy === 'system') {
    const overdue = await Invoice.exists({ business: business._id, status: { $in: ['pending', 'partial'] }, dueDate: { $lt: new Date() } });
    if (!overdue) {
      Object.assign(acc, { status: 'active', suspendedReason: undefined, suspendedAt: undefined, suspendedBy: undefined });
      changed = true;
      await log(null, business._id, 'account.reactivated', { reason: 'Payment received' });
    }
  }
  if (changed) {
    acc.paidUntil = paidUntil;
    business.set('account', acc);
    await business.save();
  }
  return business;
}

/** Creates a bill. amount is the actual price; discount defaults to the account's discount. */
export async function createInvoice(business, { amount, discount, periodStart, periodEnd, dueDate, description, notes, planName, createdBy = 'admin', accountDiscount = false }) {
  const settings = await Setting.get();
  const acc = plain(business.account);
  const amt = round(amount);
  // Plan bills use the account's discount; one-off bills only get the discount you type
  const disc = round(discount != null ? Math.min(discount, amt) : accountDiscount ? discountFor(acc, amt) : 0);
  const start = periodStart ? new Date(periodStart) : undefined;
  const invoice = await Invoice.create({
    number: await nextInvoiceNumber(),
    business: business._id,
    description: description || '',
    planName,
    periodStart: start,
    periodEnd: periodEnd ? new Date(periodEnd) : start ? addMonths(start, CYCLE_MONTHS[acc.billingCycle || 'monthly']) : undefined,
    amount: amt,
    discount: disc,
    total: round(amt - disc),
    balance: round(amt - disc),
    status: amt - disc <= 0 ? 'paid' : 'pending',
    dueDate: dueDate ? new Date(dueDate) : new Date(Date.now() + settings.invoiceDueDays * 864e5),
    notes: notes || '',
    createdBy,
  });
  await applyCredit(business._id);
  await recalcInvoice(invoice);
  await refreshAccount(business);
  return invoice;
}

/** The bill for the next period of an account's plan. */
export async function invoiceNextPeriod(business, { createdBy = 'admin', from } = {}) {
  const acc = plain(business.account);
  const plan = acc.plan ? await Plan.findById(acc.plan).lean() : null;
  const amount = listPrice(acc, plan);
  const last = await Invoice.findOne({ business: business._id, periodEnd: { $exists: true }, status: { $ne: 'cancelled' } }).sort({ periodEnd: -1 }).lean();
  const start = from || last?.periodEnd || (acc.trialEndsAt && acc.trialEndsAt > new Date() ? acc.trialEndsAt : new Date());
  const months = CYCLE_MONTHS[acc.billingCycle || plan?.billingCycle || 'monthly'];
  const settings = await Setting.get();
  return createInvoice(business, {
    amount,
    periodStart: start,
    periodEnd: addMonths(start, months),
    dueDate: new Date(new Date(start).getTime() + settings.invoiceDueDays * 864e5),
    planName: plan?.name || 'Custom plan',
    accountDiscount: true,
    description: `${plan?.name || 'Subscription'} · ${CYCLE_LABEL[acc.billingCycle || 'monthly']}`,
    createdBy,
  });
}

/** Status shown in admin lists. */
export function accountState(business, { openBalance = 0, overdue = false } = {}) {
  const acc = plain(business.account);
  if (acc.status === 'suspended') return 'suspended';
  if (overdue) return 'overdue';
  if (acc.trialEndsAt && new Date(acc.trialEndsAt) > new Date() && !acc.paidUntil) return 'trial';
  if (openBalance > 0) return 'due';
  if (!acc.plan && acc.price == null) return 'no_plan';
  return 'active';
}

/** Billing summary for one business (used by admin detail and the owner's Billing page). */
export async function billingSummary(business) {
  const acc = plain(business.account);
  const [plan, invoices, payments, credit, settings] = await Promise.all([
    acc.plan ? Plan.findById(acc.plan).lean() : null,
    Invoice.find({ business: business._id }).sort({ createdAt: -1 }).limit(100).lean(),
    Payment.find({ business: business._id }).sort({ paidAt: -1 }).limit(100).populate('allocations.invoice', 'number').lean(),
    creditFor(business._id),
    Setting.get(),
  ]);
  const open = invoices.filter((i) => ['pending', 'partial'].includes(i.status));
  const now = new Date();
  const due = round(open.reduce((s, i) => s + i.balance, 0));
  const overdueAmount = round(open.filter((i) => i.dueDate && new Date(i.dueDate) < now).reduce((s, i) => s + i.balance, 0));
  const paidTotal = round(payments.filter((p) => p.status === 'confirmed').reduce((s, p) => s + p.amount, 0));
  const price = listPrice(acc, plan);
  return {
    account: { ...acc, plan: plan || null },
    price,
    discount: discountFor(acc, price),
    netPrice: round(price - discountFor(acc, price)),
    due,
    overdueAmount,
    credit,
    paidTotal,
    state: accountState(business, { openBalance: due, overdue: overdueAmount > 0 }),
    invoices,
    payments,
    payTo: { companyName: settings.companyName, upiId: settings.upiId, bankDetails: settings.bankDetails, instructions: settings.paymentInstructions, supportPhone: settings.supportPhone, supportEmail: settings.supportEmail },
  };
}

/**
 * Worker step: creates the next bill a few days before a paid period ends, and
 * (if turned on in settings) pauses accounts whose bills are overdue.
 */
export async function runBilling(now = new Date()) {
  const settings = await Setting.get();
  let created = 0;
  let paused = 0;
  const accounts = await Business.find({ 'account.autoInvoice': { $ne: false }, $or: [{ 'account.plan': { $exists: true, $ne: null } }, { 'account.price': { $gt: 0 } }] });
  for (const b of accounts) {
    try {
      const acc = plain(b.account);
      if (acc.status === 'suspended') continue; // no new bills while paused
      const plan = acc.plan ? await Plan.findById(acc.plan).lean() : null;
      if (listPrice(acc, plan) <= 0) continue;
      const last = await Invoice.findOne({ business: b._id, periodEnd: { $exists: true }, status: { $ne: 'cancelled' } }).sort({ periodEnd: -1 }).lean();
      const anchor = last?.periodEnd || acc.trialEndsAt || b.createdAt;
      if (new Date(anchor).getTime() - 3 * 864e5 <= now.getTime()) {
        await invoiceNextPeriod(b, { createdBy: 'system', from: last?.periodEnd ? undefined : new Date(Math.max(now.getTime(), new Date(anchor).getTime())) });
        created += 1;
      }
    } catch (err) {
      console.warn(`[billing] ${b.name}: ${err.message}`);
    }
  }
  if (settings.autoSuspendOverdueDays > 0) {
    const cutoff = new Date(now.getTime() - settings.autoSuspendOverdueDays * 864e5);
    const late = await Invoice.distinct('business', { status: { $in: ['pending', 'partial'] }, dueDate: { $lt: cutoff } });
    for (const id of late) {
      const b = await Business.findById(id);
      if (!b || b.account?.status === 'suspended') continue;
      b.set('account', { ...plain(b.account), status: 'suspended', suspendedBy: 'system', suspendedAt: now, suspendedReason: `Payment overdue by more than ${settings.autoSuspendOverdueDays} days` });
      await b.save();
      await log(null, b._id, 'account.suspended', { reason: 'Payment overdue', by: 'system' });
      paused += 1;
    }
  }
  if (created || paused) console.log(`[billing] ${created} bill(s) created, ${paused} account(s) paused`);
  return { created, paused };
}

/** Everything needed to print a bill or receipt. */
export async function invoiceDocument(invoice) {
  const [business, settings, payments] = await Promise.all([
    Business.findById(invoice.business).select('name phone email address owner').populate('owner', 'name email').lean(),
    Setting.get(),
    Payment.find({ 'allocations.invoice': invoice._id, status: 'confirmed' }).sort({ paidAt: 1 }).lean(),
  ]);
  return {
    invoice,
    business: business && {
      name: business.name, phone: business.phone, email: business.email || business.owner?.email,
      ownerName: business.owner?.name, address: business.address,
    },
    payments: payments.map((p) => ({
      _id: p._id, paidAt: p.paidAt, method: p.method, reference: p.reference,
      amount: round((p.allocations || []).filter((a) => String(a.invoice) === String(invoice._id)).reduce((x, a) => x + a.amount, 0)),
    })),
    from: {
      companyName: settings.companyName, upiId: settings.upiId, bankDetails: settings.bankDetails,
      instructions: settings.paymentInstructions, supportPhone: settings.supportPhone, supportEmail: settings.supportEmail,
    },
  };
}
