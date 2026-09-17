import { PAYMENT_PROVIDERS, PAYMENT_STATUS } from '../../config/constants';
import { PaymentModel } from '../../models/Payment';
import { logger } from '../../utils/logger';
import type { PaymentProvider, VerifyPaymentResult } from './PaymentProvider';
import { applyProviderReport } from './paymentConfirmation.service';
import { paymentRegistry } from './registry';

export interface ReconcileOptions {
  now?: Date;
  /** Leave a payment alone while the customer may still be on the provider's page. */
  checkAfterMs?: number;
  /** Close an attempt the provider still reports unpaid after this long. */
  abandonAfterMs?: number;
  limit?: number;
}

export interface ReconcileResult {
  checked: number;
  activated: number;
  failed: number;
  abandoned: number;
  stillPending: number;
  providerErrors: number;
}

const MINUTE = 60_000;

/**
 * Settles gateway payments nobody came back to confirm.
 *
 * A customer can approve a payment and then close the browser before the
 * callback runs, or never pay at all. For each stale PENDING gateway payment
 * the provider is asked - never assumed:
 *
 *   - approved by the customer  -> finalised with the provider and activated,
 *     through the same confirmation rules as every other path (amount and
 *     currency must match);
 *   - failed / cancelled at the provider -> recorded as such;
 *   - still unpaid well past `abandonAfterMs` -> closed as abandoned. Only when
 *     the provider explicitly reports it unpaid: a "paid" report missing its
 *     amount stays pending for a human, never auto-closed;
 *   - never started with the provider at all (no provider id) -> failed.
 *
 * Manual payments are a human's to settle and are never touched. Safe to run
 * concurrently or repeatedly: every state change is an atomic claim.
 */
export async function reconcileStalePayments(options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const now = options.now ?? new Date();
  const checkAfterMs = options.checkAfterMs ?? 15 * MINUTE;
  const abandonAfterMs = options.abandonAfterMs ?? 24 * 60 * MINUTE;
  const result: ReconcileResult = { checked: 0, activated: 0, failed: 0, abandoned: 0, stillPending: 0, providerErrors: 0 };

  const stale = await PaymentModel.find({
    status: PAYMENT_STATUS.PENDING,
    provider: { $ne: PAYMENT_PROVIDERS.MANUAL },
    createdAt: { $lte: new Date(now.getTime() - checkAfterMs) },
  })
    .sort({ createdAt: 1 })
    .limit(options.limit ?? 100)
    .select('_id provider providerTransactionId createdAt')
    .lean();

  for (const payment of stale) {
    result.checked += 1;

    if (!payment.providerTransactionId) {
      const closed = await PaymentModel.updateOne(
        { _id: payment._id, status: PAYMENT_STATUS.PENDING, providerTransactionId: null },
        { $set: { status: PAYMENT_STATUS.FAILED, failureReason: 'The payment was never started with the provider', 'metadata.reconciledAt': now } },
      );
      if (closed.modifiedCount > 0) result.failed += 1;
      continue;
    }

    let provider: PaymentProvider;
    try {
      provider = paymentRegistry.get(payment.provider);
    } catch {
      result.stillPending += 1;
      continue;
    }
    if (!provider.isConfigured()) {
      result.stillPending += 1;
      continue;
    }

    let report: VerifyPaymentResult;
    try {
      // A payment the customer approved but never returned from is captured here.
      report = provider.completePayment
        ? await provider.completePayment(payment.providerTransactionId)
        : await provider.verifyPayment(payment.providerTransactionId);
    } catch (error) {
      result.providerErrors += 1;
      logger.warn('Could not reconcile a payment with its provider', {
        paymentId: String(payment._id),
        provider: payment.provider,
        error: error instanceof Error ? error.message : 'unknown',
      });
      continue;
    }

    const outcome = await applyProviderReport(payment._id, report, 'reconcile');
    if (outcome.outcome === 'activated') {
      result.activated += 1;
      continue;
    }
    if (outcome.outcome === 'failed') {
      result.failed += 1;
      continue;
    }

    const abandoned =
      report.status === 'pending' &&
      outcome.outcome === 'pending' &&
      payment.createdAt.getTime() <= now.getTime() - abandonAfterMs;
    if (abandoned) {
      const closed = await PaymentModel.updateOne(
        { _id: payment._id, status: PAYMENT_STATUS.PENDING },
        {
          $set: {
            status: PAYMENT_STATUS.CANCELLED,
            failureReason: 'Abandoned: the customer never completed the payment',
            'metadata.abandonedAt': now,
          },
        },
      );
      if (closed.modifiedCount > 0) {
        result.abandoned += 1;
        continue;
      }
    }
    result.stillPending += 1;
  }

  return result;
}
