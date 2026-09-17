import type { Types } from 'mongoose';
import type { SubscriptionPlanDoc } from '../../models/SubscriptionPlan';
import { prorationFor } from '../../services/subscription/proration.service';
import { offerForPlan } from '../../services/subscription/purchasePricing.service';
import { couponService } from '../coupons/coupons.service';

/**
 * Moves that earn credit for the unused part of the running paid period:
 * moving UP a plan, or moving the same plan to annual billing. A downgrade (or
 * annual -> monthly) made immediately forfeits the time left - the way to keep
 * it is to schedule the change for the end of the period, which is offered
 * alongside.
 */
const earnsCredit = (transitionKind: string, target: { interval: string }) =>
  transitionKind === 'upgrade' || (transitionKind === 'cycle-change' && target.interval === 'yearly');

type PricedPlan = Pick<SubscriptionPlanDoc, 'code' | 'priceMinor' | 'currency' | 'interval'> & { _id: Types.ObjectId };

/**
 * What a workspace pays to move onto a plan, worked out entirely on the server:
 *
 *   list price     pricing engine, for the workspace's own POS type
 *   − coupon       coupon service, on the list price
 *   − credit       unused time on the current paid period (upgrades, and monthly -> annual)
 *   = payable      never below zero
 *
 * If the credit is worth more than the new plan, the excess is returned to the
 * account wallet when the move is activated (`walletRefundMinor`).
 */
export async function breakdownFor(tenantId: Types.ObjectId, plan: PricedPlan, transitionKind: string, couponCode?: string) {
  const offer = await offerForPlan(tenantId, plan);
  const coupon = couponCode
    ? await couponService.quote({ code: couponCode, tenantId, planId: plan._id, amountMinor: offer.listPriceMinor })
    : null;
  const afterCouponMinor = coupon ? coupon.finalAmountMinor : offer.listPriceMinor;

  const credit = earnsCredit(transitionKind, plan) ? await prorationFor(tenantId) : null;
  const creditMinor = credit?.creditMinor ?? 0;
  const walletRefundMinor = Math.max(0, creditMinor - afterCouponMinor);
  const payableMinor = Math.max(0, afterCouponMinor - creditMinor);

  return {
    offer,
    coupon,
    afterCouponMinor,
    payableMinor,
    proration: credit
      ? {
          sourceSubscriptionId: credit.subscriptionId,
          sourcePlanCode: credit.planCode,
          paidMinor: credit.paidMinor,
          periodMinutes: credit.periodMinutes,
          remainingMinutes: credit.remainingMinutes,
          creditMinor,
          /** Credit used against this purchase. */
          appliedMinor: creditMinor - walletRefundMinor,
          walletRefundMinor,
        }
      : null,
  };
}

export type PurchaseBreakdown = Awaited<ReturnType<typeof breakdownFor>>;
