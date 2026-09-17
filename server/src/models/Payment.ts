import { Schema, model, type Types } from 'mongoose';
import { PAYMENT_STATUS, PAYMENT_PURPOSES, VERIFICATION_METHODS, type PaymentPurpose, type VerificationMethod } from '../config/constants';
import type { BaseDoc } from './types';

export interface PaymentDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  /**
   * The account that pays. Workspace-scoped payments still carry `tenantId`;
   * account-level ones (a wallet top-up) may have no workspace at all.
   * Resolved on the server from the workspace - never taken from a request.
   */
  accountId: Types.ObjectId | null;
  /** What the money is for. Mirrors `metadata.purpose` for older records. */
  purpose: PaymentPurpose;
  /** How this payment was proven, once it was. */
  verificationMethod: VerificationMethod;
  verifiedAt: Date | null;
  /** A pending payment stops being claimable after this moment. */
  expiresAt: Date | null;
  /** The merchant wallet/account the customer was told to pay into. */
  merchantAccount: string;
  /** The number the customer paid FROM, where the provider reports it. */
  customerPhone: string;
  /** The reference as the customer or the SMS gave it. Null when none was declared. */
  rawReference: string | null;
  userId: Types.ObjectId | null;
  subscriptionId: Types.ObjectId | null;
  planId: Types.ObjectId | null;
  amountMinor: number;
  currency: string;
  provider: string;
  /** Provider-side identifier (bKash paymentID, Nagad orderId, bank ref...). */
  providerTransactionId: string | null;
  providerReference: string | null;
  status: string;
  failureReason: string | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  /** Guards against double-charging when a webhook is delivered twice. */
  idempotencyKey: string | null;
  /** Lease taken while a paid payment is turned into a subscription, so it happens once. */
  activationClaimedAt: Date | null;
  /** Set when a payment needs a platform admin's attention (overpaid, unconfirmed, contradictory). */
  review: PaymentReview;
  /** Money returned to the customer, recorded by a platform admin. Never more than was paid. */
  refunds: PaymentRefund[];
  refundedMinor: number;
  /** What a platform admin did to the subscription after refunding this payment. At most once. */
  subscriptionAdjustment: SubscriptionAdjustment | null;
  /** When platform admins were last alerted about this payment. */
  alerts: { reviewNotifiedAt: Date | null; staleNotifiedAt: Date | null };
  /** The invoice issued for this payment, once it has been paid and activated. */
  invoiceId: Types.ObjectId | null;
  metadata: Record<string, unknown>;
}

export const SUBSCRIPTION_ADJUSTMENTS = ['end_now', 'shorten'] as const;
export type SubscriptionAdjustmentAction = (typeof SUBSCRIPTION_ADJUSTMENTS)[number];

export interface SubscriptionAdjustment {
  action: SubscriptionAdjustmentAction;
  /** The new end of the period (now, for end_now). */
  until: Date;
  previousEnd: Date;
  reason: string;
  at: Date;
  by: Types.ObjectId | null;
  byNameSnapshot: string;
}

export interface PaymentReview {
  required: boolean;
  reason: string;
  flaggedAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: Types.ObjectId | null;
  resolvedByNameSnapshot: string;
  resolutionNote: string;
}

export const REFUND_METHODS = ['provider_portal', 'bank_transfer', 'cash'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

export interface PaymentRefund {
  _id: Types.ObjectId;
  amountMinor: number;
  /** How the money actually went back: the provider's merchant portal, a transfer, cash. */
  method: RefundMethod;
  /** The provider's or bank's refund reference, so it can be traced. */
  reference: string;
  reason: string;
  at: Date;
  by: Types.ObjectId | null;
  byNameSnapshot: string;
}

const paymentSchema = new Schema<PaymentDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', default: null, index: true },
    planId: { type: Schema.Types.ObjectId, ref: 'SubscriptionPlan', default: null },
    amountMinor: { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'amountMinor must be an integer' } },
    currency: { type: String, required: true, uppercase: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', default: null, index: true },
    purpose: { type: String, enum: Object.values(PAYMENT_PURPOSES), default: PAYMENT_PURPOSES.SUBSCRIPTION_PURCHASE, index: true },
    verificationMethod: { type: String, enum: [...VERIFICATION_METHODS], default: 'none' },
    verifiedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    merchantAccount: { type: String, default: '', trim: true, maxlength: 40 },
    customerPhone: { type: String, default: '', trim: true, maxlength: 40 },
    rawReference: { type: String, default: null, trim: true, maxlength: 120 },
    provider: { type: String, required: true, index: true },
    providerTransactionId: { type: String, default: null },
    providerReference: { type: String, default: null },
    status: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.PENDING, index: true },
    failureReason: { type: String, default: null },
    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    idempotencyKey: { type: String, default: null },
    activationClaimedAt: { type: Date, default: null },
    review: {
      required: { type: Boolean, default: false },
      reason: { type: String, default: '' },
      flaggedAt: { type: Date, default: null },
      resolvedAt: { type: Date, default: null },
      resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      resolvedByNameSnapshot: { type: String, default: '' },
      resolutionNote: { type: String, default: '', maxlength: 500 },
    },
    refunds: {
      type: [
        new Schema<PaymentRefund>({
          amountMinor: { type: Number, required: true, min: 1, validate: { validator: Number.isSafeInteger, message: 'amountMinor must be an integer' } },
          method: { type: String, enum: [...REFUND_METHODS], required: true },
          reference: { type: String, required: true, maxlength: 120 },
          reason: { type: String, required: true, maxlength: 500 },
          at: { type: Date, default: () => new Date() },
          by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          byNameSnapshot: { type: String, default: '' },
        }),
      ],
      default: [],
    },
    refundedMinor: { type: Number, default: 0, min: 0 },
    subscriptionAdjustment: {
      type: new Schema<SubscriptionAdjustment>(
        {
          action: { type: String, enum: [...SUBSCRIPTION_ADJUSTMENTS], required: true },
          until: { type: Date, required: true },
          previousEnd: { type: Date, required: true },
          reason: { type: String, required: true, maxlength: 300 },
          at: { type: Date, default: () => new Date() },
          by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          byNameSnapshot: { type: String, default: '' },
        },
        { _id: false },
      ),
      default: null,
    },
    alerts: {
      reviewNotifiedAt: { type: Date, default: null },
      staleNotifiedAt: { type: Date, default: null },
    },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

// NOTE: `sparse` only skips documents where the field is ABSENT. Both of these
// fields default to null, so a sparse unique index would index that null and
// reject the second payment that leaves it unset. A partial filter on the
// value's type is the correct guard.
paymentSchema.index(
  { provider: 1, providerTransactionId: 1 },
  { unique: true, partialFilterExpression: { providerTransactionId: { $type: 'string' } } },
);
paymentSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
paymentSchema.index({ tenantId: 1, createdAt: -1 });
// Platform payment operations: the open review queue, and status queues by age.
paymentSchema.index(
  { 'review.resolvedAt': 1, createdAt: -1 },
  { partialFilterExpression: { 'review.required': true }, name: 'open_review_queue' },
);
paymentSchema.index({ status: 1, createdAt: -1 });
// Reconciliation reads: an account's payments, and the pending queue by purpose.
paymentSchema.index({ accountId: 1, createdAt: -1 });
paymentSchema.index({ purpose: 1, status: 1, createdAt: -1 });
// A customer-declared reference is claimed once platform-wide, so the same
// Send Money receipt cannot be submitted against two payments.
paymentSchema.index(
  { rawReference: 1 },
  { unique: true, partialFilterExpression: { rawReference: { $type: 'string' } } },
);

export const PaymentModel = model<PaymentDoc>('Payment', paymentSchema);
