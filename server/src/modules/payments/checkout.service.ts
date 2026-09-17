import type { Types } from 'mongoose';
import { PAYMENT_STATUS } from '../../config/constants';
import { env } from '../../config/env';
import { PaymentModel } from '../../models/Payment';
import { UpgradeRequestModel } from '../../models/UpgradeRequest';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { paymentRegistry } from '../../services/payment/registry';
import { pricingRecordOf } from '../../services/subscription/purchasePricing.service';
import { breakdownFor } from '../subscriptions/purchaseBreakdown';
import { planChangeService } from '../subscriptions/planChange.service';
import type { TenantContext } from '../../types/express';

/** Where the provider sends the customer's browser back to. */
const callbackUrlFor = (provider: string) => `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/payments/callback/${provider}`;

export interface StartCheckoutInput {
  planId: Types.ObjectId;
  provider: string;
  returnUrl?: string;
  cancelUrl?: string;
  /** Client retry key: the same key returns the payment already opened. */
  idempotencyKey?: string;
}

/**
 * Starts a gateway payment: records it as PENDING, then asks the provider to
 * create it and hands back the provider's payment page. Nothing is ever marked
 * paid here - only the provider's own confirmation (callback, verify or a
 * verified notification) can do that.
 *
 * The amount is the pricing engine's price for this workspace's POS type,
 * fixed here and recorded with how it was priced. Every later confirmation is
 * checked against it, never against the browser.
 */
export async function startCheckout(ctx: TenantContext, input: StartCheckoutInput) {
  const storedKey = input.idempotencyKey ? `checkout:${String(ctx.tenantId)}:${input.idempotencyKey}` : null;
  if (storedKey) {
    const existing = await PaymentModel.findOne({ idempotencyKey: storedKey }).lean();
    if (existing) {
      if (!existing.planId || !existing.planId.equals(input.planId)) {
        throw ApiError.conflict('That purchase key was already used for a different plan', { reason: 'IDEMPOTENCY_KEY_REUSED' });
      }
      const redirectUrl = (existing.metadata as { redirectUrl?: string } | undefined)?.redirectUrl ?? null;
      return { paymentId: existing._id, redirectUrl, status: existing.status, amountMinor: existing.amountMinor, currency: existing.currency, replayed: true };
    }
  }

  // Exactly the rules a manual or wallet upgrade follows: the plan is offered to
  // this vertical, it is not the plan already running (unless renewing), and a
  // downgrade only when current usage fits.
  const { plan, verdict, isRenewal } = await planChangeService.assertAllowed(ctx.tenantId, input.planId);

  // One way to pay at a time: a manual request awaiting review would activate a
  // plan too, so the two cannot both be in flight.
  if (await UpgradeRequestModel.exists({ tenantId: ctx.tenantId, status: 'pending' })) {
    throw ApiError.conflict('You already have an upgrade request awaiting review. Cancel it before paying online.');
  }

  const provider = paymentRegistry.get(input.provider);
  if (!provider.isConfigured()) {
    throw ApiError.badRequest(`${provider.displayName} payments are not available yet. Please contact support to pay manually.`);
  }

  // Engine price less credit for unused paid time. A provider cannot take a zero payment.
  const priced = await breakdownFor(ctx.tenantId, plan, isRenewal ? 'renewal' : verdict.kind);
  const offer = priced.offer;
  if (priced.payableMinor <= 0) {
    throw ApiError.badRequest('Your credit for unused time covers this plan, so there is nothing to pay online. Pay from your wallet instead - nothing is charged.', {
      reason: 'NOTHING_TO_PAY_ONLINE',
    });
  }

  // Recorded first, so its id can travel to the provider as our reference.
  let payment;
  try {
    payment = await PaymentModel.create({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      planId: plan._id,
      amountMinor: priced.payableMinor,
      currency: offer.currency,
      provider: provider.name,
      providerTransactionId: null,
      status: PAYMENT_STATUS.PENDING,
      idempotencyKey: storedKey,
      metadata: {
        initiatedBy: ctx.userName,
        pricing: pricingRecordOf(offer),
        proration: priced.proration,
        prorationCreditAppliedMinor: priced.proration?.appliedMinor ?? 0,
      },
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000 && storedKey) {
      throw ApiError.conflict('This purchase is already being started. Try again in a moment.', { reason: 'PURCHASE_IN_PROGRESS' });
    }
    throw error;
  }

  try {
    const result = await provider.initiatePayment({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      subscriptionId: null,
      planId: plan._id,
      amountMinor: priced.payableMinor,
      currency: offer.currency,
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
      reference: String(payment._id),
      callbackUrl: callbackUrlFor(provider.name),
    });
    await PaymentModel.updateOne(
      { _id: payment._id, providerTransactionId: null },
      { $set: { providerTransactionId: result.providerTransactionId, 'metadata.redirectUrl': result.redirectUrl ?? null } },
    );
    return {
      paymentId: payment._id,
      redirectUrl: result.redirectUrl ?? null,
      status: PAYMENT_STATUS.PENDING,
      amountMinor: priced.payableMinor,
      currency: offer.currency,
      replayed: false,
    };
  } catch (error) {
    await PaymentModel.updateOne(
      { _id: payment._id, status: PAYMENT_STATUS.PENDING },
      { $set: { status: PAYMENT_STATUS.FAILED, failureReason: 'The payment could not be started with the provider' } },
    );
    logger.warn('Starting a gateway payment failed', { provider: provider.name, error: error instanceof Error ? error.message : 'unknown' });
    throw new ApiError('PROVIDER_UNAVAILABLE', `${provider.displayName} could not start the payment right now. Please try again shortly.`);
  }
}
