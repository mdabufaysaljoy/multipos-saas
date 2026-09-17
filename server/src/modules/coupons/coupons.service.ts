import { Types } from 'mongoose';
import { CouponModel, CouponRedemptionModel } from '../../models/Coupon';
import { ApiError } from '../../utils/ApiError';
import { applyBasisPoints } from '../../utils/money';
import { resolvePage } from '../../utils/pagination';

export interface CouponQuote {
  couponId: Types.ObjectId;
  code: string;
  originalAmountMinor: number;
  discountMinor: number;
  finalAmountMinor: number;
}

class CouponService {
  /**
   * Validates a coupon against a specific purchase and returns what it is
   * worth. Read-only: nothing is consumed, so a customer can preview a code
   * before committing to it.
   */
  async quote(input: { code: string; tenantId: Types.ObjectId; planId: Types.ObjectId; amountMinor: number }): Promise<CouponQuote> {
    const coupon = await CouponModel.findOne({ code: input.code.trim().toUpperCase() });
    if (!coupon) throw ApiError.notFound('That coupon code is not valid');
    if (!coupon.isActive) throw ApiError.badRequest('This coupon is no longer active');

    const now = new Date();
    if (coupon.startsAt && coupon.startsAt > now) throw ApiError.badRequest('This coupon is not available yet');
    if (coupon.expiresAt && coupon.expiresAt < now) throw ApiError.badRequest('This coupon has expired');

    if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) {
      throw ApiError.badRequest('This coupon has reached its usage limit');
    }

    if (coupon.applicablePlanIds.length > 0 && !coupon.applicablePlanIds.some((id) => String(id) === String(input.planId))) {
      throw ApiError.badRequest('This coupon does not apply to the selected plan');
    }

    if (input.amountMinor < coupon.minPurchaseMinor) {
      throw ApiError.badRequest(`This coupon needs a minimum purchase of ${(coupon.minPurchaseMinor / 100).toFixed(2)}`);
    }

    const usedByTenant = await CouponRedemptionModel.countDocuments({ couponId: coupon._id, tenantId: input.tenantId });
    if (usedByTenant >= coupon.perTenantLimit) {
      throw ApiError.badRequest('You have already used this coupon');
    }

    // Integer maths only; a percentage is basis points.
    let discountMinor =
      coupon.discountType === 'percent' ? applyBasisPoints(input.amountMinor, coupon.discountValue) : coupon.discountValue;

    if (coupon.maxDiscountMinor > 0) discountMinor = Math.min(discountMinor, coupon.maxDiscountMinor);
    // Never discount below zero, and never turn a purchase into a payout.
    discountMinor = Math.max(0, Math.min(discountMinor, input.amountMinor));

    return {
      couponId: coupon._id,
      code: coupon.code,
      originalAmountMinor: input.amountMinor,
      discountMinor,
      finalAmountMinor: input.amountMinor - discountMinor,
    };
  }

  /**
   * Consumes one use. The `$lt` guard on `usedCount` makes the global usage
   * limit safe under concurrency: two simultaneous redemptions of the last
   * remaining use cannot both succeed.
   */
  async redeem(quote: CouponQuote, tenantId: Types.ObjectId, upgradeRequestId: Types.ObjectId | null) {
    const coupon = await CouponModel.findById(quote.couponId).select('usageLimit code').lean();
    if (!coupon) throw ApiError.notFound('Coupon not found');

    const claimed = await CouponModel.findOneAndUpdate(
      {
        _id: quote.couponId,
        isActive: true,
        ...(coupon.usageLimit > 0 ? { usedCount: { $lt: coupon.usageLimit } } : {}),
      },
      { $inc: { usedCount: 1 } },
      { new: true },
    );

    if (!claimed) throw ApiError.conflict('This coupon has just reached its usage limit');

    await CouponRedemptionModel.create({
      couponId: quote.couponId,
      couponCodeSnapshot: quote.code,
      tenantId,
      upgradeRequestId,
      originalAmountMinor: quote.originalAmountMinor,
      discountMinor: quote.discountMinor,
      finalAmountMinor: quote.finalAmountMinor,
    });

    return claimed.toObject();
  }

  /** Gives a use back when a discounted request is rejected or cancelled. */
  async release(couponId: Types.ObjectId, tenantId: Types.ObjectId, upgradeRequestId: Types.ObjectId) {
    const removed = await CouponRedemptionModel.findOneAndDelete({ couponId, tenantId, upgradeRequestId });
    if (!removed) return;
    await CouponModel.updateOne({ _id: couponId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
  }

  // -------------------------------------------------------- platform admin

  async list(input: { page?: number; limit?: number; isActive?: boolean }) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = {};
    if (input.isActive !== undefined) filter.isActive = input.isActive;

    const [items, total] = await Promise.all([
      CouponModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CouponModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  async create(input: Record<string, unknown>, createdBy: Types.ObjectId | null) {
    const code = String(input.code).trim().toUpperCase();
    const duplicate = await CouponModel.findOne({ code }).select('_id').lean();
    if (duplicate) throw ApiError.conflict('A coupon with this code already exists');

    const coupon = await CouponModel.create({ ...input, code, createdBy });
    return coupon.toObject();
  }

  async update(id: Types.ObjectId, input: Record<string, unknown>) {
    if (input.code) {
      const code = String(input.code).trim().toUpperCase();
      const duplicate = await CouponModel.findOne({ code, _id: { $ne: id } }).select('_id').lean();
      if (duplicate) throw ApiError.conflict('A coupon with this code already exists');
      input.code = code;
    }

    // usedCount is derived from redemptions and must never be set by hand.
    delete input.usedCount;

    const coupon = await CouponModel.findByIdAndUpdate(id, { $set: input }, { new: true }).lean();
    if (!coupon) throw ApiError.notFound('Coupon not found');
    return coupon;
  }
}

export const couponService = new CouponService();
