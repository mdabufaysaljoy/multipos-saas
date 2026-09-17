import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const TOPUP_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type TopUpStatus = (typeof TOPUP_STATUSES)[number];

/**
 * A customer's claim that they have sent money to top up their wallet.
 *
 * Submitting one credits NOTHING. A platform admin verifies the transaction and
 * approves it; only then does the balance move.
 */
export interface TopUpRequestDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  requestedBy: Types.ObjectId;
  requestedByNameSnapshot: string;
  amountMinor: number;
  currency: string;
  paymentMethod: string;
  senderNumber: string;
  transactionId: string;
  note: string;
  status: TopUpStatus;
  reviewedBy: Types.ObjectId | null;
  reviewedByNameSnapshot: string;
  reviewedAt: Date | null;
  reviewNote: string;
  walletTransactionId: Types.ObjectId | null;
  /** The receipt issued once the top-up was approved and credited. */
  receiptId: Types.ObjectId | null;
}

const topUpSchema = new Schema<TopUpRequestDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByNameSnapshot: { type: String, default: '' },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, default: 'BDT', uppercase: true },
    paymentMethod: { type: String, required: true },
    senderNumber: { type: String, default: '', trim: true },
    transactionId: { type: String, required: true, trim: true },
    note: { type: String, default: '', maxlength: 500 },
    status: { type: String, enum: [...TOPUP_STATUSES], default: 'pending', index: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedByNameSnapshot: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: '' },
    walletTransactionId: { type: Schema.Types.ObjectId, ref: 'WalletTransaction', default: null },
    receiptId: { type: Schema.Types.ObjectId, ref: 'WalletReceipt', default: null },
  },
  { timestamps: true },
);

// A transaction reference can only be claimed once platform-wide.
topUpSchema.index({ transactionId: 1 }, { unique: true });
topUpSchema.index({ tenantId: 1, createdAt: -1 });

export const TopUpRequestModel = model<TopUpRequestDoc>('TopUpRequest', topUpSchema);
