import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const UPGRADE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type UpgradeRequestStatus = (typeof UPGRADE_REQUEST_STATUSES)[number];

/**
 * A customer's request to move onto a higher plan, paid for manually
 * (bKash / Nagad / bank transfer).
 *
 * Submitting one changes NOTHING about the subscription. A platform admin must
 * approve it, and only then is the plan applied - so a customer cannot upgrade
 * themselves by claiming to have paid.
 */
export interface UpgradeRequestDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  requestedBy: Types.ObjectId;
  requestedByNameSnapshot: string;
  planId: Types.ObjectId;
  /** Frozen so an later price change cannot alter what was agreed. */
  planSnapshot: { code: string; name: string; interval: string; priceMinor: number; currency: string };
  currentPlanCodeSnapshot: string | null;
  /**
   * upgrade | cycle-change | downgrade. Downgrades go through the same review
   * queue rather than a parallel model.
   */
  transitionKind: string;

  paymentMethod: string;
  /** Discount applied at submission, frozen so later coupon edits don't shift it. */
  couponId: Types.ObjectId | null;
  couponCodeSnapshot: string | null;
  discountMinor: number;
  /** What the customer says they sent, in minor units. */
  amountMinor: number;
  senderNumber: string;
  transactionId: string;
  note: string;

  status: UpgradeRequestStatus;
  reviewedBy: Types.ObjectId | null;
  reviewedByNameSnapshot: string;
  reviewedAt: Date | null;
  reviewNote: string;
  /** Set once approval creates the new subscription. */
  resultingSubscriptionId: Types.ObjectId | null;
  paymentId: Types.ObjectId | null;
  /** How the server priced this request. Null on requests from before the pricing engine. */
  pricing: UpgradeRequestPricing | null;
  /** Client retry key: the same key returns this request instead of buying again. */
  idempotencyKey: string | null;
  /** Credit for unused time on the plan being replaced, worked out at submission. */
  proration: UpgradeRequestProration | null;
}

export interface UpgradeRequestProration {
  sourceSubscriptionId: Types.ObjectId;
  sourcePlanCode: string;
  paidMinor: number;
  periodMinutes: number;
  remainingMinutes: number;
  creditMinor: number;
  appliedMinor: number;
  walletRefundMinor: number;
}

export interface UpgradeRequestPricing {
  source: 'catalog' | 'plan';
  posType: string;
  catalogPlanCode: string | null;
  billingCycle: string;
  priceId: Types.ObjectId | null;
  listPriceMinor: number;
  currency: string;
}

const upgradeRequestSchema = new Schema<UpgradeRequestDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByNameSnapshot: { type: String, default: '' },
    planId: { type: Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },
    planSnapshot: {
      code: { type: String, required: true },
      name: { type: String, required: true },
      interval: { type: String, required: true },
      priceMinor: { type: Number, required: true },
      currency: { type: String, required: true },
    },
    currentPlanCodeSnapshot: { type: String, default: null },
    transitionKind: { type: String, enum: ['upgrade', 'cycle-change', 'downgrade', 'renewal'], default: 'upgrade', index: true },

    paymentMethod: { type: String, required: true },
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', default: null },
    couponCodeSnapshot: { type: String, default: null },
    discountMinor: { type: Number, default: 0, min: 0 },
    amountMinor: { type: Number, required: true, min: 0 },
    senderNumber: { type: String, default: '', trim: true },
    transactionId: { type: String, required: true, trim: true },
    note: { type: String, default: '', maxlength: 500 },

    status: { type: String, enum: [...UPGRADE_REQUEST_STATUSES], default: 'pending', index: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedByNameSnapshot: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: '' },
    resultingSubscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', default: null },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
    pricing: {
      type: new Schema<UpgradeRequestPricing>(
        {
          source: { type: String, enum: ['catalog', 'plan'], required: true },
          posType: { type: String, required: true },
          catalogPlanCode: { type: String, default: null },
          billingCycle: { type: String, required: true },
          priceId: { type: Schema.Types.ObjectId, ref: 'PlanPrice', default: null },
          listPriceMinor: { type: Number, required: true, min: 0 },
          currency: { type: String, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    idempotencyKey: { type: String, default: null },
    proration: {
      type: new Schema<UpgradeRequestProration>(
        {
          sourceSubscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', required: true },
          sourcePlanCode: { type: String, default: '' },
          paidMinor: { type: Number, required: true, min: 0 },
          periodMinutes: { type: Number, required: true, min: 1 },
          remainingMinutes: { type: Number, required: true, min: 0 },
          creditMinor: { type: Number, required: true, min: 0 },
          appliedMinor: { type: Number, required: true, min: 0 },
          walletRefundMinor: { type: Number, required: true, min: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);

upgradeRequestSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

// One transaction id can only ever be claimed once across the platform.
upgradeRequestSchema.index({ transactionId: 1 }, { unique: true });
upgradeRequestSchema.index({ tenantId: 1, createdAt: -1 });
upgradeRequestSchema.index({ status: 1, createdAt: -1 });

export const UpgradeRequestModel = model<UpgradeRequestDoc>('UpgradeRequest', upgradeRequestSchema);
