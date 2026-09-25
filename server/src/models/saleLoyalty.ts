import { Schema, type Types } from 'mongoose';

/**
 * The loyalty card a sale earned or redeemed on, snapshotted onto the sale.
 *
 * Every vertical that runs the card program stores exactly this, because the
 * shared loyalty service reads a sale by these field names (see
 * `loyalty.service.ts`, `LoyaltySaleModel`) and the return maths works from the
 * running totals at the bottom.
 */
export interface SaleLoyaltySnapshot {
  membershipId: Types.ObjectId;
  cardNumber: string;
  pointValueMinor: number;
  earnSpendMinor: number;
  pointsRedeemed: number;
  /** pointsRedeemed x pointValueMinor. */
  discountMinor: number;
  /** What earned points: the goods, less discounts, never VAT - and never what this vertical excludes. */
  qualifyingMinor: number;
  pointsEarned: number;
  /** Card balance right after this sale, for the receipt. */
  balanceAfter: number;
  /** Running totals given back by returns and voids. */
  pointsEarnedReversed: number;
  pointsRedeemedRestored: number;
}

const minor = { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'Amounts must be whole minor units' } };

/** A fresh sub-schema per sale model; Mongoose does not share one instance across models. */
export const saleLoyaltySchema = () =>
  new Schema<SaleLoyaltySnapshot>(
    {
      membershipId: { type: Schema.Types.ObjectId, ref: 'LoyaltyMembership', required: true },
      cardNumber: { type: String, required: true },
      pointValueMinor: minor,
      earnSpendMinor: minor,
      pointsRedeemed: { type: Number, default: 0, min: 0 },
      discountMinor: minor,
      qualifyingMinor: minor,
      pointsEarned: { type: Number, default: 0, min: 0 },
      balanceAfter: { type: Number, default: 0 },
      pointsEarnedReversed: { type: Number, default: 0, min: 0 },
      pointsRedeemedRestored: { type: Number, default: 0, min: 0 },
    },
    { _id: false },
  );
