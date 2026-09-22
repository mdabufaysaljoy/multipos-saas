import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const LOYALTY_CARD_STATUSES = ['active', 'inactive'] as const;
export type LoyaltyCardStatus = (typeof LOYALTY_CARD_STATUSES)[number];

export interface LoyaltyFeePayment {
  method: string;
  amountMinor: number;
  reference: string;
}

/**
 * A loyalty membership card, linked to exactly one customer profile of the same
 * branch (customers are per branch, so memberships are too).
 *
 * The BARCODE is the loyalty identity at the till - never the phone or email.
 * It is opaque (random digits, no customer data), issued once and never
 * changed, so reprinting a card always prints the same code.
 *
 * `pointsBalance` is a cached figure for fast lookups. It only ever moves by an
 * atomic `$inc` that is paired with a `LoyaltyTransaction` row, so it can be
 * reconciled from the ledger at any time.
 */
export interface LoyaltyMembershipDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  customerId: Types.ObjectId;
  /** Human-readable card number, e.g. LM-000012. Unique per branch. */
  cardNumber: string;
  /** EAN-13 in the restricted-circulation "299" range. Unique platform-wide. */
  barcode: string;
  status: LoyaltyCardStatus;
  pointsBalance: number;
  pointsEarnedTotal: number;
  pointsRedeemedTotal: number;
  /** The fee charged when the card was issued (0 = free), as set in the store's loyalty settings then. */
  membershipFeeMinor: number;
  feePayments: LoyaltyFeePayment[];
  feeChangeMinor: number;
  issuedAt: Date;
  issuedBy: Types.ObjectId;
  issuedByNameSnapshot: string;
  statusChangedAt: Date | null;
  statusChangedBy: Types.ObjectId | null;
  statusReason: string;
  /** Per-issue request key, so a retried "issue card" never creates a second card. */
  idempotencyKey: string | null;
}

const membershipSchema = new Schema<LoyaltyMembershipDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    cardNumber: { type: String, required: true, immutable: true },
    barcode: { type: String, required: true, immutable: true },
    status: { type: String, enum: LOYALTY_CARD_STATUSES, default: 'active' },
    pointsBalance: { type: Number, default: 0, validate: { validator: Number.isSafeInteger, message: 'points must be whole' } },
    pointsEarnedTotal: { type: Number, default: 0, min: 0 },
    pointsRedeemedTotal: { type: Number, default: 0, min: 0 },
    membershipFeeMinor: { type: Number, default: 0, min: 0 },
    feePayments: {
      type: [
        new Schema<LoyaltyFeePayment>(
          {
            method: { type: String, required: true },
            amountMinor: { type: Number, required: true, min: 0 },
            reference: { type: String, default: '' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    feeChangeMinor: { type: Number, default: 0, min: 0 },
    issuedAt: { type: Date, default: Date.now },
    issuedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    issuedByNameSnapshot: { type: String, default: '' },
    statusChangedAt: { type: Date, default: null },
    statusChangedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    statusReason: { type: String, default: '', maxlength: 300 },
    idempotencyKey: { type: String, default: null },
  },
  { timestamps: true },
);

// Scanning looks a card up by barcode: unique across the whole platform.
membershipSchema.index({ barcode: 1 }, { unique: true });
membershipSchema.index({ tenantId: 1, storeId: 1, cardNumber: 1 }, { unique: true });
// One ACTIVE card per customer; inactive cards stay for history.
membershipSchema.index({ tenantId: 1, storeId: 1, customerId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
membershipSchema.index({ tenantId: 1, storeId: 1, status: 1, issuedAt: -1 });
membershipSchema.index({ tenantId: 1, storeId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

export const LoyaltyMembershipModel = model<LoyaltyMembershipDoc>('LoyaltyMembership', membershipSchema);
