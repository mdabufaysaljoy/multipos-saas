import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 *   earn              + points for a completed sale
 *   redeem            - points spent as a discount on a sale
 *   redeem_reversed   + points given back because the sale did not complete
 *   earn_reversed     - points taken back for returned or cancelled goods
 *   redeem_restored   + redeemed points given back for returned or cancelled goods
 *   adjustment        +/- manual correction with a reason (loyalty.manage)
 */
export const LOYALTY_TX_TYPES = ['earn', 'redeem', 'redeem_reversed', 'earn_reversed', 'redeem_restored', 'adjustment'] as const;
export type LoyaltyTxType = (typeof LOYALTY_TX_TYPES)[number];

/** Append-only point ledger. Every change to a card's balance writes exactly one row. */
export interface LoyaltyTransactionDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  membershipId: Types.ObjectId;
  customerId: Types.ObjectId;
  type: LoyaltyTxType;
  /** Signed, whole points. */
  points: number;
  balanceBefore: number;
  balanceAfter: number;
  saleId: Types.ObjectId | null;
  saleNumber: string;
  returnId: Types.ObjectId | null;
  returnNumber: string;
  reason: string;
  performedBy: Types.ObjectId | null;
  performedByNameSnapshot: string;
  /**
   * Makes a balance change happen at most once: e.g. `earn:<saleId>`,
   * `redeem:<saleId>`, `return:<returnId>:earn`. A retry hits the unique index.
   */
  dedupeKey: string;
}

const loyaltyTxSchema = new Schema<LoyaltyTransactionDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    membershipId: { type: Schema.Types.ObjectId, ref: 'LoyaltyMembership', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    type: { type: String, enum: LOYALTY_TX_TYPES, required: true },
    points: { type: Number, required: true, validate: { validator: Number.isSafeInteger, message: 'points must be whole' } },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', default: null },
    saleNumber: { type: String, default: '' },
    returnId: { type: Schema.Types.ObjectId, ref: 'Return', default: null },
    returnNumber: { type: String, default: '' },
    reason: { type: String, default: '', maxlength: 300 },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    performedByNameSnapshot: { type: String, default: '' },
    dedupeKey: { type: String, required: true },
  },
  { timestamps: true },
);

loyaltyTxSchema.index({ tenantId: 1, dedupeKey: 1 }, { unique: true });
loyaltyTxSchema.index({ tenantId: 1, membershipId: 1, createdAt: -1 });
loyaltyTxSchema.index({ tenantId: 1, saleId: 1 });

export const LoyaltyTransactionModel = model<LoyaltyTransactionDoc>('LoyaltyTransaction', loyaltyTxSchema);
