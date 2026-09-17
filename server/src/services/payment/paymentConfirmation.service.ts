import { walletService } from '../wallet/wallet.service';
import type { Types } from 'mongoose';
import { PAYMENT_STATUS } from '../../config/constants';
import { PaymentModel } from '../../models/Payment';
import { SubscriptionEventModel } from '../../models/SubscriptionEvent';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { openSubscriptionPeriod } from '../subscription/activation.service';
import { issueInvoiceSafely } from '../billing/invoice.service';

/** What a provider said about a payment, from `verifyPayment` or a signed webhook. */
export interface ProviderReport {
  status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'refunded' | null;
  amountMinor: number | null;
  currency: string | null;
  paidAt: Date | null;
  failureReason?: string;
}

export type ConfirmationOutcome = 'activated' | 'already_processed' | 'pending' | 'failed' | 'unverifiable';

/** How long one activation attempt holds a payment before another may retry it. */
const ACTIVATION_LEASE_MS = 2 * 60 * 1000;

/** Fields that put a payment in the platform admins' review queue (re-opening a resolved review). */
export const reviewFlag = (reason: string, at = new Date()) => ({
  'review.required': true,
  'review.reason': reason,
  'review.flaggedAt': at,
  'review.resolvedAt': null,
  'review.resolvedBy': null,
  'review.resolvedByNameSnapshot': '',
  'review.resolutionNote': '',
});

/**
 * Applies a provider's report to a payment. The ONLY way a gateway payment
 * becomes paid, shared by the verify endpoint and the webhook.
 *
 *   - A payment is paid only when the provider confirms BOTH the amount and
 *     the currency. A report without them leaves it pending for review.
 *   - Less than the recorded price, or another currency, fails the payment.
 *     More is accepted and flagged for a refund review.
 *   - pending -> paid is one atomic update, so a verify and a webhook (or two
 *     webhook deliveries) racing for the same payment activate it once.
 *   - Anything that is no longer pending is never changed by a report; a
 *     "paid" report for a failed payment is flagged for review instead.
 */
export async function applyProviderReport(
  paymentId: Types.ObjectId,
  report: ProviderReport,
  source: 'verify' | 'webhook' | 'callback' | 'reconcile' | 'admin',
): Promise<{ outcome: ConfirmationOutcome; payment: Record<string, unknown>; reason?: string }> {
  const payment = await PaymentModel.findById(paymentId).lean();
  if (!payment) throw ApiError.notFound('Payment not found');
  const reload = async () => (await PaymentModel.findById(paymentId).lean()) as Record<string, unknown>;

  if (payment.status === PAYMENT_STATUS.PAID) {
    // Paid but possibly never activated (a crash in between): finish it now.
    await resumeActivation(payment._id);
    return { outcome: 'already_processed', payment: await reload() };
  }

  if (payment.status !== PAYMENT_STATUS.PENDING) {
    if (report.status === 'paid') {
      logger.warn('Provider reported a non-pending payment as paid', { paymentId: String(payment._id), status: payment.status, source });
      await PaymentModel.updateOne(
        { _id: payment._id },
        { $set: reviewFlag(`Provider reported paid via ${source} for a ${payment.status} payment`) },
      );
    }
    return { outcome: 'already_processed', payment: await reload() };
  }

  if (!report.status || report.status === 'pending') return { outcome: 'pending', payment: payment as Record<string, unknown> };

  const fail = async (status: string, reason: string) => {
    const failed = await PaymentModel.findOneAndUpdate(
      { _id: payment._id, status: PAYMENT_STATUS.PENDING },
      { $set: { status, failureReason: reason, 'metadata.failedVia': source } },
      { new: true },
    ).lean();
    return failed
      ? { outcome: 'failed' as const, payment: failed as Record<string, unknown>, reason }
      : { outcome: 'already_processed' as const, payment: await reload() };
  };

  if (report.status !== 'paid') {
    const status = report.status === 'cancelled' ? PAYMENT_STATUS.CANCELLED : PAYMENT_STATUS.FAILED;
    return fail(status, report.failureReason || `The provider reported the payment as ${report.status}`);
  }

  // ---- paid: the money must be proven before anything is activated --------
  if (!Number.isSafeInteger(report.amountMinor) || !report.currency) {
    const reason = 'The provider did not confirm the amount and currency';
    await PaymentModel.updateOne(
      { _id: payment._id, status: PAYMENT_STATUS.PENDING },
      { $set: { failureReason: reason, 'metadata.integrity': 'unverifiable', 'metadata.unverifiableVia': source, ...reviewFlag(reason) } },
    );
    return { outcome: 'unverifiable', payment: await reload(), reason };
  }
  const amountMinor = report.amountMinor as number;
  const currency = report.currency.toUpperCase();

  if (currency !== String(payment.currency).toUpperCase()) {
    return fail(PAYMENT_STATUS.FAILED, `The payment was made in ${currency}, not ${payment.currency}`);
  }
  if (amountMinor < payment.amountMinor) {
    return fail(PAYMENT_STATUS.FAILED, 'The amount received was less than the price');
  }

  const overpaidMinor = amountMinor - payment.amountMinor;
  const claimed = await PaymentModel.findOneAndUpdate(
    { _id: payment._id, status: PAYMENT_STATUS.PENDING },
    {
      $set: {
        status: PAYMENT_STATUS.PAID,
        paidAt: report.paidAt ?? new Date(),
        failureReason: null,
        'metadata.confirmedVia': source,
        'metadata.providerAmountMinor': amountMinor,
        'metadata.providerCurrency': currency,
        ...(overpaidMinor > 0 ? { 'metadata.overpaidMinor': overpaidMinor, ...reviewFlag('Overpaid: refund the difference') } : {}),
      },
    },
    { new: true },
  ).lean();
  // Another report won the race; it owns the activation.
  if (!claimed) return { outcome: 'already_processed', payment: await reload() };

  await resumeActivation(claimed._id);
  return { outcome: 'activated', payment: await reload() };
}

/**
 * Turns a PAID payment into its subscription period, exactly once.
 *
 * Claimed with a short lease: a second caller waits out the lease instead of
 * activating twice, and a process that died mid-activation is retried by the
 * next verify or webhook delivery. Returns null when there is nothing to do.
 */
/** The list price recorded when a payment was opened; older payments fall back to their amount. */
const quotedListPrice = (payment: { amountMinor: number; metadata?: Record<string, unknown> | null }) => {
  const listPrice = (payment.metadata?.pricing as { listPriceMinor?: unknown } | undefined)?.listPriceMinor;
  return typeof listPrice === 'number' && Number.isSafeInteger(listPrice) ? listPrice : payment.amountMinor;
};

export async function resumeActivation(paymentId: Types.ObjectId) {
  const now = new Date();

  // A confirmed wallet top-up adds money instead of opening a subscription.
  // Keyed by the payment, so duplicate callbacks and webhooks credit once.
  const purpose = await PaymentModel.findById(paymentId).select('status metadata').lean();
  if (purpose?.status === PAYMENT_STATUS.PAID && (purpose.metadata as { purpose?: string } | undefined)?.purpose === 'wallet_topup') {
    const credited = await walletService.creditFromPayment(paymentId);
    await PaymentModel.updateOne(
      { _id: paymentId, 'metadata.walletTransactionId': { $exists: false } },
      { $set: { 'metadata.walletTransactionId': credited.transaction._id } },
    );
    return null;
  }
  const claimed = await PaymentModel.findOneAndUpdate(
    {
      _id: paymentId,
      status: PAYMENT_STATUS.PAID,
      subscriptionId: null,
      $or: [{ activationClaimedAt: null }, { activationClaimedAt: { $lt: new Date(now.getTime() - ACTIVATION_LEASE_MS) } }],
    },
    { $set: { activationClaimedAt: now } },
    { new: true },
  ).lean();
  if (!claimed) return null;

  const plan = claimed.planId ? await SubscriptionPlanModel.findById(claimed.planId) : null;
  if (!plan) {
    logger.error('A paid payment references a plan that no longer exists', { paymentId: String(paymentId) });
    await PaymentModel.updateOne({ _id: paymentId }, { $set: reviewFlag('Paid for a plan that no longer exists') });
    return null;
  }

  const subscription = await openSubscriptionPeriod({
    tenantId: claimed.tenantId,
    plan,
    stackOnSamePlan: true,
    autoRenew: true,
    provider: claimed.provider,
    isManual: false,
    lastPaymentId: claimed._id,
    notes: `Activated by ${claimed.provider} payment`,
    // The price quoted when the payment was opened (pricing engine), not today's plan price.
    priceMinor: quotedListPrice(claimed),
    currency: claimed.currency,
  });
  await PaymentModel.updateOne({ _id: claimed._id, subscriptionId: null }, { $set: { subscriptionId: subscription._id } });
  await issueInvoiceSafely(claimed._id);

  await SubscriptionEventModel.create({
    tenantId: claimed.tenantId,
    subscriptionId: subscription._id,
    type: 'activated',
    message: `Payment confirmed via ${claimed.provider}`,
    data: { paymentId: String(claimed._id), amountMinor: claimed.amountMinor, currency: claimed.currency },
    actorId: null,
    actorNameSnapshot: claimed.provider,
  });

  return subscription;
}
