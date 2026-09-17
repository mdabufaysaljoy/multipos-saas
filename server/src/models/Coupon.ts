import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * A platform-issued discount on subscription purchases.
 *
 * `usedCount` is only ever incremented through an atomic conditional update, so
 * a coupon with a usage limit cannot be redeemed past that limit even if two
 * customers submit at the same moment.
 */
export interface CouponDoc extends BaseDoc {
  code: string;
  description: string;
  discountType: 'percent' | 'fixed';
  /** Basis points when percent (1000 = 10%); minor units when fixed. */
  discountValue: number;
  /** Caps a percentage discount. 0 means no cap. */
  maxDiscountMinor: number;
  minPurchaseMinor: number;
  /** Empty means every plan qualifies. */
  applicablePlanIds: Types.ObjectId[];
  /** 0 means unlimited. */
  usageLimit: number;
  usedCount: number;
  /** Redemptions allowed per tenant. */
  perTenantLimit: number;
  startsAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
  createdBy: Types.ObjectId | null;
}

const couponSchema = new Schema<CouponDoc>(
  {
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 32 },
    description: { type: String, default: '', maxlength: 300 },
    discountType: { type: String, enum: ['percent', 'fixed'], required: true },
    discountValue: { type: Number, required: true, min: 1, validate: { validator: Number.isSafeInteger, message: 'discountValue must be an integer' } },
    maxDiscountMinor: { type: Number, default: 0, min: 0 },
    minPurchaseMinor: { type: Number, default: 0, min: 0 },
    applicablePlanIds: { type: [{ type: Schema.Types.ObjectId, ref: 'SubscriptionPlan' }], default: [] },
    usageLimit: { type: Number, default: 0, min: 0 },
    usedCount: { type: Number, default: 0, min: 0 },
    perTenantLimit: { type: Number, default: 1, min: 1 },
    startsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

couponSchema.index({ code: 1 }, { unique: true });

export const CouponModel = model<CouponDoc>('Coupon', couponSchema);

/** One row per redemption, so per-tenant limits are enforceable and auditable. */
export interface CouponRedemptionDoc extends BaseDoc {
  couponId: Types.ObjectId;
  couponCodeSnapshot: string;
  tenantId: Types.ObjectId;
  upgradeRequestId: Types.ObjectId | null;
  originalAmountMinor: number;
  discountMinor: number;
  finalAmountMinor: number;
}

const redemptionSchema = new Schema<CouponRedemptionDoc>(
  {
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', required: true, index: true },
    couponCodeSnapshot: { type: String, required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    upgradeRequestId: { type: Schema.Types.ObjectId, ref: 'UpgradeRequest', default: null },
    originalAmountMinor: { type: Number, required: true },
    discountMinor: { type: Number, required: true },
    finalAmountMinor: { type: Number, required: true },
  },
  { timestamps: true },
);

redemptionSchema.index({ couponId: 1, tenantId: 1 });

export const CouponRedemptionModel = model<CouponRedemptionDoc>('CouponRedemption', redemptionSchema);
