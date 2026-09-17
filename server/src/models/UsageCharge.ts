import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/** Paid platform services billed per use from the account wallet. */
export const USAGE_SERVICES = ['sms', 'email', 'ai', 'storage'] as const;
export type UsageService = (typeof USAGE_SERVICES)[number];

/**
 *   pending             created, wallet not yet debited
 *   charged             wallet debited for the full amount
 *   partially_refunded  some of the amount returned
 *   refunded            the whole amount returned
 *   failed              the debit never happened (e.g. insufficient balance)
 */
export const USAGE_CHARGE_STATUSES = ['pending', 'charged', 'partially_refunded', 'refunded', 'failed'] as const;
export type UsageChargeStatus = (typeof USAGE_CHARGE_STATUSES)[number];

export interface UsageRefund {
  refundId: Types.ObjectId;
  amountMinor: number;
  reason: string;
  /** pending -> crediting -> completed. Only one caller can move it to crediting. */
  status: 'pending' | 'crediting' | 'completed';
  walletTransactionId: Types.ObjectId | null;
  createdAt: Date;
}

/**
 * One billed use of a paid service: what was used, how much of it, at what
 * unit price, for how much, and what happened to the money.
 *
 * The wallet ledger records the money; this records the USAGE behind it, with
 * the unit price frozen at the moment of use so a later price change never
 * rewrites a past charge. Every amount field only moves through
 * `usageChargeService`, by conditional updates.
 */
export interface UsageChargeDoc extends BaseDoc {
  /** The paying account. Null only for a workspace not linked to an account. */
  accountId: Types.ObjectId | null;
  /** The workspace that used the service. */
  tenantId: Types.ObjectId;
  walletId: Types.ObjectId | null;
  service: UsageService;
  unit: string;
  quantity: number;
  unitPriceMinor: number;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
  status: UsageChargeStatus;
  debitTransactionId: Types.ObjectId | null;
  refunds: UsageRefund[];
  description: string;
  /** What the usage was for, e.g. an SMS campaign. */
  referenceType: string | null;
  referenceId: Types.ObjectId | null;
  /** Makes a retried charge return the original instead of billing twice. */
  idempotencyKey: string | null;
  performedBy: Types.ObjectId | null;
  performedByNameSnapshot: string;
  failureReason: string | null;
  metadata: Record<string, unknown>;
}

const minorAmount = {
  type: Number,
  required: true,
  min: 0,
  validate: { validator: Number.isSafeInteger, message: 'Amounts must be whole minor units' },
};

const refundSchema = new Schema<UsageRefund>(
  {
    refundId: { type: Schema.Types.ObjectId, required: true },
    amountMinor: { ...minorAmount, min: 1 },
    reason: { type: String, required: true, maxlength: 300 },
    status: { type: String, enum: ['pending', 'crediting', 'completed'], default: 'pending' },
    walletTransactionId: { type: Schema.Types.ObjectId, default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const usageChargeSchema = new Schema<UsageChargeDoc>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', default: null },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    walletId: { type: Schema.Types.ObjectId, ref: 'Wallet', default: null },
    service: { type: String, enum: [...USAGE_SERVICES], required: true },
    unit: { type: String, required: true },
    quantity: { ...minorAmount },
    unitPriceMinor: { ...minorAmount },
    amountMinor: { ...minorAmount },
    refundedMinor: { ...minorAmount, default: 0, required: false },
    currency: { type: String, default: 'BDT', uppercase: true },
    status: { type: String, enum: [...USAGE_CHARGE_STATUSES], required: true },
    debitTransactionId: { type: Schema.Types.ObjectId, default: null },
    refunds: { type: [refundSchema], default: [] },
    description: { type: String, required: true, maxlength: 300 },
    referenceType: { type: String, default: null },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    idempotencyKey: { type: String, default: null, maxlength: 200 },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    performedByNameSnapshot: { type: String, default: 'system' },
    failureReason: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

usageChargeSchema.index({ tenantId: 1, createdAt: -1 });
usageChargeSchema.index({ accountId: 1, createdAt: -1 });
usageChargeSchema.index({ referenceType: 1, referenceId: 1 });
// Interrupted work for the reconciler to finish.
usageChargeSchema.index({ status: 1, createdAt: 1 });
usageChargeSchema.index({ 'refunds.status': 1 });
usageChargeSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

export const UsageChargeModel = model<UsageChargeDoc>('UsageCharge', usageChargeSchema);
