import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const BILLING_CYCLES = ['monthly', 'annual'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

/**
 * The price of one catalog plan, for one POS product, on one billing cycle,
 * over a period of time.
 *
 *   POS product + plan + billing cycle  ->  amount (integer minor units) + currency
 *
 * Prices are versioned, never edited: a new price is a new row with its own
 * `effectiveFrom`, and the row it replaces gets `effectiveTo`. The price in
 * effect at a moment is the row with the latest `effectiveFrom` at or before
 * it (and no `effectiveTo` at or before it). If that row is inactive, the
 * combination cannot be bought - there is no silent fallback to an older price.
 */
export interface PlanPriceDoc extends BaseDoc {
  posProductId: Types.ObjectId;
  /** Snapshot of the POS product code, for readable queries and audit. */
  posProductCode: string;
  planId: Types.ObjectId;
  planCode: string;
  billingCycle: BillingCycle;
  /** Integer minor units (poisha): 99_000 = BDT 990.00. */
  amountMinor: number;
  /** ISO 4217, e.g. BDT. */
  currency: string;
  active: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  note: string;
  createdBy: Types.ObjectId | null;
  createdByNameSnapshot: string;
}

const planPriceSchema = new Schema<PlanPriceDoc>(
  {
    posProductId: { type: Schema.Types.ObjectId, ref: 'PosProduct', required: true, immutable: true },
    posProductCode: { type: String, required: true, immutable: true },
    planId: { type: Schema.Types.ObjectId, ref: 'CatalogPlan', required: true, immutable: true },
    planCode: { type: String, required: true, immutable: true },
    billingCycle: { type: String, enum: [...BILLING_CYCLES], required: true, immutable: true },
    amountMinor: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
      validate: { validator: Number.isSafeInteger, message: 'amountMinor must be a whole number of minor units' },
    },
    currency: { type: String, required: true, uppercase: true, match: /^[A-Z]{3}$/, immutable: true },
    active: { type: Boolean, default: true },
    effectiveFrom: { type: Date, required: true, immutable: true },
    effectiveTo: { type: Date, default: null },
    note: { type: String, trim: true, maxlength: 200, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdByNameSnapshot: { type: String, default: '' },
  },
  { timestamps: true },
);

// One version per combination per start moment.
planPriceSchema.index({ posProductId: 1, planId: 1, billingCycle: 1, effectiveFrom: 1 }, { unique: true });
// "The price in effect" and the admin list.
planPriceSchema.index({ posProductCode: 1, planCode: 1, billingCycle: 1, effectiveFrom: -1 });

export const PlanPriceModel = model<PlanPriceDoc>('PlanPrice', planPriceSchema);
