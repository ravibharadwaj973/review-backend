import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireBusinessAnyStatus } from '../../middleware/auth.js';
import { ah, parse, badRequest, notFound } from '../../utils/http.js';
import { Payment, PAYMENT_METHODS, Invoice } from '../../models/index.js';
import { billingSummary, invoiceDocument, log } from './service.js';

/** The business's own view of its plan, bills and payments. Works while the account is paused. */
export const billingRouter = Router();
billingRouter.use(requireAuth, requireBusinessAnyStatus);

billingRouter.get('/', ah(async (req, res) => {
  res.json(await billingSummary(req.business));
}));

/** "I've paid" — the business reports a payment; an admin confirms it. */
billingRouter.post('/report-payment', ah(async (req, res) => {
  const body = parse(z.object({
    amount: z.number().positive('Enter the amount you paid').max(10_000_000),
    method: z.enum(PAYMENT_METHODS).default('upi'),
    reference: z.string().trim().min(3, 'Add the UPI / transaction reference so we can find it').max(120),
    paidAt: z.string().optional(),
    notes: z.string().max(500).optional().default(''),
  }), req.body);
  const waiting = await Payment.countDocuments({ business: req.business._id, status: 'pending' });
  if (waiting >= 5) throw badRequest('You already have payments waiting for confirmation. We’ll check them soon.');
  const payment = await Payment.create({
    ...body,
    paidAt: body.paidAt ? new Date(body.paidAt) : new Date(),
    business: req.business._id,
    status: 'pending',
    submittedBy: 'owner',
    recordedBy: req.user._id,
  });
  await log(null, req.business._id, 'payment.reported', { amount: body.amount, method: body.method, reference: body.reference });
  res.status(201).json({ payment });
}));

/** One bill, for printing or saving as PDF. */
billingRouter.get('/invoices/:id', ah(async (req, res) => {
  const invoice = await Invoice.findOne({ _id: req.params.id, business: req.business._id }).lean();
  if (!invoice) throw notFound('Bill');
  res.json(await invoiceDocument(invoice));
}));
