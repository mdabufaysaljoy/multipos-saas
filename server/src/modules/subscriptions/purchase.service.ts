import { PERMISSIONS } from '../../config/permissions';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { TenantModel } from '../../models/Tenant';
import { UpgradeRequestModel } from '../../models/UpgradeRequest';
import { ApiError } from '../../utils/ApiError';
import { minorToDecimalString } from '../../services/payment/money';
import { paymentRegistry } from '../../services/payment/registry';
import { pricingService } from '../../services/pricing/pricing.service';
import type { TenantContext } from '../../types/express';
import { startCheckout } from '../payments/checkout.service';
import { planChangeService } from './planChange.service';
import { breakdownFor } from './purchaseBreakdown';
import type { PurchaseInput, PurchaseQuoteInput } from './purchase.validators';
import { upgradeService } from './upgrades.service';

/** Long enough for a wallet purchase or a provider round trip; short enough to expire if a process dies. */
const PURCHASE_LOCK_MS = 30_000;

/**
 * Subscription purchasing in catalog terms: plan + billing cycle + how to pay.
 *
 * Every figure comes from the server: the plan SKU from the catalog mapping,
 * the list price from the pricing engine for the workspace's own POS type, the
 * discount from the coupon service, credit for unused time on the current
 * paid period, and the wallet debit from what is left. The request contains
 * none of them.
 *
 * Existing rules are reused, not reimplemented: `planChangeService` decides
 * whether the move is allowed, `upgradeService` settles wallet purchases and
 * files manual requests, `startCheckout` opens online payments.
 */
class PurchaseService {
  /** The live plan SKU a catalog plan and cycle are sold as. */
  private async skuFor(plan: string, billingCycle: PurchaseQuoteInput['billingCycle']) {
    const code = await pricingService.legacyCodeFor(plan, billingCycle);
    if (!code) throw ApiError.notFound('Unknown plan');
    const sku = await SubscriptionPlanModel.findOne({ code, isActive: true });
    if (!sku) throw ApiError.conflict('This plan is not available right now', { reason: 'PLAN_UNAVAILABLE' });
    return sku;
  }

  /** What this workspace would pay, and whether the move is allowed - without buying anything. */
  async quote(ctx: TenantContext, input: PurchaseQuoteInput) {
    const sku = await this.skuFor(input.plan, input.billingCycle);
    const { verdict, isRenewal, currentPlan } = await planChangeService.assertAllowed(ctx.tenantId, sku._id);
    const kind = isRenewal ? 'renewal' : verdict.kind;
    const priced = await breakdownFor(ctx.tenantId, sku, kind, input.couponCode);
    const { offer, coupon, payableMinor, proration } = priced;

    return {
      plan: { code: input.plan, name: sku.name, tier: sku.tier },
      billingCycle: offer.billingCycle,
      posType: offer.posType,
      currency: offer.currency,
      listPriceMinor: offer.listPriceMinor,
      listPrice: minorToDecimalString(offer.listPriceMinor),
      discountMinor: coupon?.discountMinor ?? 0,
      payableMinor,
      payable: minorToDecimalString(payableMinor),
      paidMonths: offer.paidMonths,
      freeMonths: offer.freeMonths,
      savingsMinor: offer.savingsMinor,
      coupon: coupon ? { code: coupon.code, discountMinor: coupon.discountMinor } : null,
      proration: proration
        ? {
            sourcePlanCode: proration.sourcePlanCode,
            creditMinor: proration.creditMinor,
            appliedMinor: proration.appliedMinor,
            walletRefundMinor: proration.walletRefundMinor,
            remainingMinutes: proration.remainingMinutes,
            periodMinutes: proration.periodMinutes,
          }
        : null,
      walletRefundMinor: proration?.walletRefundMinor ?? 0,
      transition: { kind, currentPlanCode: currentPlan?.code ?? null },
      paymentMethods: {
        wallet: true,
        // A provider cannot take a zero payment.
        online: payableMinor > 0 ? paymentRegistry.listAvailable().map((provider) => provider.name) : [],
        manual: payableMinor > 0 ? ['bkash', 'nagad', 'bank'] : [],
      },
    };
  }

  /**
   * Buys a plan. Only one purchase runs per workspace at a time (a short lease
   * on the workspace), so two clicks, two tabs or two devices cannot both
   * debit the wallet. A retry carrying the same idempotency key returns the
   * first attempt's result instead of buying again.
   */
  async purchase(ctx: TenantContext, input: PurchaseInput) {
    if (input.paymentMethod === 'wallet' && !ctx.can(PERMISSIONS.WALLET_MANAGE)) {
      throw ApiError.forbidden('Paying from the account wallet needs the "wallet.manage" permission');
    }
    const sku = await this.skuFor(input.plan, input.billingCycle);

    const now = new Date();
    const lockUntil = new Date(now.getTime() + PURCHASE_LOCK_MS);
    const locked = await TenantModel.findOneAndUpdate(
      { _id: ctx.tenantId, $or: [{ purchaseLockedUntil: null }, { purchaseLockedUntil: { $exists: false } }, { purchaseLockedUntil: { $lt: now } }] },
      { $set: { purchaseLockedUntil: lockUntil } },
      { new: true },
    )
      .select('_id')
      .lean();
    if (!locked) {
      throw ApiError.conflict('Another purchase for this workspace is in progress. Try again in a moment.', { reason: 'PURCHASE_IN_PROGRESS' });
    }

    try {
      if (input.paymentMethod === 'online') {
        if (input.couponCode) throw ApiError.badRequest('Coupons can be used with wallet or manual payments');
        const result = await startCheckout(ctx, {
          planId: sku._id,
          provider: input.provider,
          returnUrl: input.returnUrl,
          cancelUrl: input.cancelUrl,
          idempotencyKey: input.idempotencyKey,
        });
        return { method: 'online' as const, ...result };
      }

      // A retry of a purchase that already went through: `upgradeService.submit`
      // returns the original before any rule is checked again (the plan may now
      // be the one running), so nothing is priced or re-validated here.
      const replaying = input.idempotencyKey
        ? Boolean(await UpgradeRequestModel.exists({ tenantId: ctx.tenantId, idempotencyKey: input.idempotencyKey }))
        : false;

      let payableMinor = 0;
      if (!replaying) {
        const { verdict, isRenewal } = await planChangeService.assertAllowed(ctx.tenantId, sku._id);
        const priced = await breakdownFor(ctx.tenantId, sku, isRenewal ? 'renewal' : verdict.kind, input.couponCode);
        // A transfer of nothing cannot be verified; when credit covers the price, the wallet path settles it.
        if (input.paymentMethod === 'manual' && priced.payableMinor <= 0) {
          throw ApiError.badRequest('Your credit covers this plan, so there is nothing to transfer. Pay from your wallet instead - nothing is charged.', {
            reason: 'NOTHING_TO_TRANSFER',
          });
        }
        payableMinor = priced.payableMinor;
      }

      // `upgradeService.submit` prices the purchase itself (engine, coupon, credit);
      // the amount passed is only the legacy "declared amount", set to that same
      // server-side figure so it can never fall short.
      const request = await upgradeService.submit(ctx, {
        planId: sku._id,
        paymentMethod: input.paymentMethod === 'wallet' ? 'wallet' : input.manualMethod,
        couponCode: input.couponCode,
        amountMinor: payableMinor,
        senderNumber: input.paymentMethod === 'manual' ? input.senderNumber : '',
        transactionId: input.paymentMethod === 'manual' ? input.transactionId : '',
        note: input.note,
        idempotencyKey: input.idempotencyKey,
      });
      const replayed = Boolean((request as { replayed?: boolean }).replayed);
      return { method: input.paymentMethod, request, replayed };
    } finally {
      // Released only if it is still ours (an expired lease may have been taken over).
      await TenantModel.updateOne({ _id: ctx.tenantId, purchaseLockedUntil: lockUntil }, { $set: { purchaseLockedUntil: null } });
    }
  }
}

export const purchaseService = new PurchaseService();
