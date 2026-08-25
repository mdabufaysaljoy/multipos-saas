import { SUBSCRIPTION_STATUS } from '../config/constants';
import { PaymentModel } from '../models/Payment';
import { SubscriptionModel } from '../models/Subscription';
import { TenantModel } from '../models/Tenant';
import { logger } from '../utils/logger';
import { addInterval } from '../services/subscription/provisioning.service';
import { paymentRegistry } from '../services/payment/registry';
import { subscriptionService } from '../modules/subscriptions/subscriptions.service';

const SYSTEM_ACTOR = { id: null, name: 'system' };

/**
 * Expires subscriptions whose period has elapsed.
 *
 * A cancelled subscription reaching its end date simply expires - cancellation
 * stops the NEXT renewal but never cuts short a period already paid for.
 */
export async function expireLapsedSubscriptions(): Promise<number> {
  const now = new Date();
  const lapsed = await SubscriptionModel.find({
    status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIAL, SUBSCRIPTION_STATUS.CANCELLED, SUBSCRIPTION_STATUS.PAST_DUE] },
    currentPeriodEnd: { $lte: now },
  }).limit(500);

  let count = 0;
  for (const subscription of lapsed) {
    // Auto-renewing subscriptions are handled by the renewal pass instead.
    if (subscription.autoRenew && !subscription.cancelAtPeriodEnd) continue;

    subscription.status = SUBSCRIPTION_STATUS.EXPIRED;
    await subscription.save();

    await TenantModel.updateOne(
      { _id: subscription.tenantId },
      { $set: { subscriptionStatus: SUBSCRIPTION_STATUS.EXPIRED } },
    );

    await subscriptionService.recordEvent(
      subscription.tenantId,
      subscription._id,
      'expired',
      'The subscription period ended',
      SYSTEM_ACTOR,
      { endedAt: subscription.currentPeriodEnd },
    );
    count += 1;
  }

  if (count > 0) logger.info(`Expired ${count} lapsed subscription(s)`);
  return count;
}

/**
 * Charges due auto-renewals through the provider that owns the subscription.
 *
 * A renewal only extends the period once the provider actually confirms the
 * charge. Failures move the subscription to `past_due`, which keeps the POS
 * usable during a grace window, and expire it after repeated attempts.
 */
export async function processRenewals(): Promise<number> {
  const now = new Date();
  const due = await SubscriptionModel.find({
    status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE] },
    autoRenew: true,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: { $lte: now },
  }).limit(200);

  let renewed = 0;
  for (const subscription of due) {
    const provider = (() => {
      try {
        return paymentRegistry.get(subscription.provider);
      } catch {
        return null;
      }
    })();

    // Manual subscriptions have nothing to charge; a human must extend them.
    if (!provider || !provider.isConfigured() || !provider.supportsRecurring() || !provider.chargeRecurring) {
      subscription.status = SUBSCRIPTION_STATUS.PAST_DUE;
      await subscription.save();
      await TenantModel.updateOne({ _id: subscription.tenantId }, { $set: { subscriptionStatus: SUBSCRIPTION_STATUS.PAST_DUE } });
      await subscriptionService.recordEvent(
        subscription.tenantId,
        subscription._id,
        'renewal_failed',
        'Automatic renewal is not available for this payment method - manual renewal required',
        SYSTEM_ACTOR,
        {},
      );
      continue;
    }

    try {
      const result = await provider.chargeRecurring({
        tenantId: subscription.tenantId,
        userId: null,
        subscriptionId: subscription._id,
        planId: subscription.planId,
        amountMinor: subscription.planSnapshot.priceMinor,
        currency: subscription.planSnapshot.currency,
        providerSubscriptionId: subscription.providerSubscriptionId ?? '',
      });

      if (result.status !== 'paid') throw new Error(result.failureReason ?? 'The charge was not completed');

      const payment = await PaymentModel.create({
        tenantId: subscription.tenantId,
        subscriptionId: subscription._id,
        planId: subscription.planId,
        amountMinor: subscription.planSnapshot.priceMinor,
        currency: subscription.planSnapshot.currency,
        provider: subscription.provider,
        providerTransactionId: result.providerTransactionId,
        status: 'paid',
        paidAt: result.paidAt ?? new Date(),
      });

      subscription.currentPeriodStart = subscription.currentPeriodEnd;
      subscription.currentPeriodEnd = addInterval(subscription.currentPeriodEnd, subscription.planSnapshot.interval);
      subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
      subscription.failedPaymentCount = 0;
      subscription.lastPaymentId = payment._id;
      await subscription.save();

      await TenantModel.updateOne(
        { _id: subscription.tenantId },
        { $set: { subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE, subscriptionEndsAt: subscription.currentPeriodEnd } },
      );

      await subscriptionService.recordEvent(
        subscription.tenantId,
        subscription._id,
        'renewed',
        `Renewed automatically via ${subscription.provider}`,
        SYSTEM_ACTOR,
        { paymentId: String(payment._id) },
      );
      renewed += 1;
    } catch (error) {
      subscription.failedPaymentCount += 1;
      // Three strikes, then access stops. Until then the tenant keeps working.
      subscription.status =
        subscription.failedPaymentCount >= 3 ? SUBSCRIPTION_STATUS.EXPIRED : SUBSCRIPTION_STATUS.PAST_DUE;
      await subscription.save();

      await TenantModel.updateOne({ _id: subscription.tenantId }, { $set: { subscriptionStatus: subscription.status } });
      await subscriptionService.recordEvent(
        subscription.tenantId,
        subscription._id,
        'renewal_failed',
        error instanceof Error ? error.message : 'The renewal payment failed',
        SYSTEM_ACTOR,
        { attempt: subscription.failedPaymentCount },
      );
    }
  }

  if (renewed > 0) logger.info(`Renewed ${renewed} subscription(s)`);
  return renewed;
}

let timer: NodeJS.Timeout | null = null;

/**
 * Simple in-process scheduler. Adequate for a single-instance deployment; swap
 * for an external scheduler (Agenda, BullMQ, cron) when running several nodes,
 * since both passes are idempotent and safe to move.
 */
export function startSubscriptionJobs(intervalMs = 60 * 60 * 1000): void {
  const run = async () => {
    try {
      await processRenewals();
      await expireLapsedSubscriptions();
    } catch (error) {
      logger.error('Subscription job failed', error);
    }
  };

  void run();
  timer = setInterval(run, intervalMs);
  // Never keep the process alive just for this timer.
  timer.unref?.();
}

export function stopSubscriptionJobs(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
