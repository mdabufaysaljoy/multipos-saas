import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const INVOICE_BILLING_CYCLES = ['monthly', 'annual'] as const;

export interface InvoiceLine {
  description: string;
  planCode: string;
  planName: string;
  billingCycle: (typeof INVOICE_BILLING_CYCLES)[number];
  posType: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  quantity: number;
  unitAmountMinor: number;
  amountMinor: number;
}

/**
 * A subscription invoice: the record of one paid subscription payment.
 *
 * IMMUTABLE. Everything on it is a snapshot taken when it was issued - who
 * issued it, who was billed, the plan, the price the payment recorded, the
 * discount and credit applied - so it never changes when prices, plans,
 * names or addresses change later. A refund does not edit the invoice: it is
 * recorded on the payment and shown alongside.
 *
 *   subtotal - discount - credit + adjustment = total = the amount paid
 *
 * `adjustment` is non-zero only for records whose payment did not record a
 * full price breakdown, or where the customer paid more than the price.
 */
export interface InvoiceDoc extends BaseDoc {
  number: string;
  year: number;
  sequence: number;
  /** The account the workspace belonged to when the invoice was issued. */
  accountId: Types.ObjectId | null;
  tenantId: Types.ObjectId;
  paymentId: Types.ObjectId;
  subscriptionId: Types.ObjectId | null;
  /** What was paid for: purchase, upgrade, downgrade, cycle-change, renewal, assigned. */
  kind: string;
  issuedAt: Date;
  currency: string;
  issuer: { name: string; address: string; email: string; phone: string };
  billedTo: { accountName: string; workspaceName: string; email: string; phone: string; country: string };
  lines: InvoiceLine[];
  subtotalMinor: number;
  discountMinor: number;
  couponCode: string | null;
  creditMinor: number;
  adjustmentMinor: number;
  totalMinor: number;
  payment: { method: string; reference: string | null; paidAt: Date | null };
}

const integer = { validator: Number.isSafeInteger, message: 'Amounts must be integers in minor units' };

const invoiceSchema = new Schema<InvoiceDoc>(
  {
    number: { type: String, required: true },
    year: { type: Number, required: true },
    sequence: { type: Number, required: true, min: 1 },
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', default: null },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', default: null },
    kind: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    currency: { type: String, required: true, uppercase: true },
    issuer: {
      name: { type: String, default: '' },
      address: { type: String, default: '' },
      email: { type: String, default: '' },
      phone: { type: String, default: '' },
    },
    billedTo: {
      accountName: { type: String, default: '' },
      workspaceName: { type: String, default: '' },
      email: { type: String, default: '' },
      phone: { type: String, default: '' },
      country: { type: String, default: '' },
    },
    lines: {
      type: [
        new Schema<InvoiceLine>(
          {
            description: { type: String, required: true },
            planCode: { type: String, required: true },
            planName: { type: String, required: true },
            billingCycle: { type: String, enum: [...INVOICE_BILLING_CYCLES], required: true },
            posType: { type: String, required: true },
            periodStart: { type: Date, default: null },
            periodEnd: { type: Date, default: null },
            quantity: { type: Number, required: true, min: 1, validate: integer },
            unitAmountMinor: { type: Number, required: true, min: 0, validate: integer },
            amountMinor: { type: Number, required: true, min: 0, validate: integer },
          },
          { _id: false },
        ),
      ],
      validate: { validator: (lines: InvoiceLine[]) => lines.length > 0, message: 'An invoice needs at least one line' },
    },
    subtotalMinor: { type: Number, required: true, min: 0, validate: integer },
    discountMinor: { type: Number, required: true, min: 0, validate: integer },
    couponCode: { type: String, default: null },
    creditMinor: { type: Number, required: true, min: 0, validate: integer },
    adjustmentMinor: { type: Number, required: true, validate: integer },
    totalMinor: { type: Number, required: true, min: 0, validate: integer },
    payment: {
      method: { type: String, required: true },
      reference: { type: String, default: null },
      paidAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

invoiceSchema.pre('validate', function checkTotals(next) {
  const expected = this.subtotalMinor - this.discountMinor - this.creditMinor + this.adjustmentMinor;
  if (expected !== this.totalMinor) return next(new Error('Invoice totals do not add up'));
  next();
});

// Issued once, never edited or removed through the application.
const IMMUTABLE_MESSAGE = 'Invoices are immutable. Record a refund on the payment instead.';
invoiceSchema.pre('save', function refuseEdits(next) {
  if (!this.isNew) return next(new Error(IMMUTABLE_MESSAGE));
  next();
});
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  invoiceSchema.pre(operation, function refuseQueryEdits(next: (error?: Error) => void) {
    next(new Error(IMMUTABLE_MESSAGE));
  });
}

invoiceSchema.index({ number: 1 }, { unique: true });
// One invoice per payment, whatever issues it and however often.
invoiceSchema.index({ paymentId: 1 }, { unique: true });
invoiceSchema.index({ tenantId: 1, issuedAt: -1 });
invoiceSchema.index({ accountId: 1, issuedAt: -1 });

export const InvoiceModel = model<InvoiceDoc>('Invoice', invoiceSchema);
