import { issueMissingReceipts } from '../services/billing/receipt.service';
import type { Types } from 'mongoose';
import { SUBSCRIPTION_STATUS } from '../config/constants';
import { SubscriptionModel, type SubscriptionDoc } from '../models/Subscription';
import { TenantModel } from '../models/Tenant';
import { logger } from '../utils/logger';
import { reconcileStalePayments } from '../services/payment/staleReconciler';
import { sendPaymentAlertDigest } from '../services/payment/paymentAlerts.service';
import { renewDueWalletSubscriptions, renewWithGateway } from '../services/subscription/walletRenewal.service';
import { sendRenewalNotice } from '../services/subscription/renewalNotices.service';
import { retryFailedEmails, sendExpiryReminders } from '../services/email/transactionalEmail.service';
import { recurringProviderFor } from '../services/subscription/renewalCapability';
import { RENEWAL_GRACE_MS, RENEWAL_MAX_ATTEMPTS, renewalGraceEndsAt } from '../services/subscription/renewalPolicy';
import { subscriptionService } from '../modules/subscriptions/subscriptions.service';
import { issueMissingInvoices } from '../services/billing/invoice.service';

type SubscriptionRecord = SubscriptionDoc & { _id: Types.ObjectId };
const SYSTEM_ACTOR = { id: null, name: 'system' };
/** Stale auto-renewing records older than this are switched off without emailing anyone. */
const STALE_NOTICE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** A gateway renewal the renewal pass will still attempt (inside the grace window, attempts left). */
const gatewayRenewalPending = (subscription: SubscriptionRecord, now: Date) =>
  subscription.autoRenew &&
  !subscription.cancelAtPeriodEnd &&
  subscription.renewWith !== 'wallet' &&
  (subscription.failedPaymentCount ?? 0) < RENEWAL_MAX_ATTEMPTS &&
  now.getTime() - subscription.currentPeriodEnd.getTime() < RENEWAL_GRACE_MS &&
  recurringProviderFor(subscription.provider) !== null;

/**
 * Expires subscriptions whose period has elapsed.
 *
 * A cancelled subscription reaching its end date simply expires - cancellation
 * stops the NEXT renewal but never cuts short a period already paid for. A
 * subscription whose automatic renewal is still being retried is left alone
 * until its grace window closes; then it ends, automatic renewal switches off
 * and the owner is told.
 */
export async function expireLapsedSubscriptions(now = new Date()): Promise<number> {
  const lapsed = await SubscriptionModel.find({
    status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIAL, SUBSCRIPTION_STATUS.CANCELLED, SUBSCRIPTION_STATUS.PAST_DUE] },
    currentPeriodEnd: { $lte: now },
  })
    .sort({ currentPeriodEnd: 1 })
    .limit(500)
    .lean<SubscriptionRecord[]>();

  let count = 0;
  for (const subscription of lapsed) {
    if (renewalGraceEndsAt(subscription, now) || gatewayRenewalPending(subscription, now)) continue;

    // Conditional on what was read, so a renewal or a status change made meanwhile is not overwritten.
    const gaveUpOnRenewal = subscription.autoRenew && !subscription.cancelAtPeriodEnd;
    const expired = await SubscriptionModel.updateOne(
      { _id: subscription._id, status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd },
      { $set: { status: SUBSCRIPTION_STATUS.EXPIRED, ...(gaveUpOnRenewal ? { autoRenew: false } : {}) } },
    );
    if (expired.modifiedCount === 0) continue;

    // Only the workspace's current subscription speaks for the workspace.
    await TenantModel.updateOne(
      { _id: subscription.tenantId, currentSubscriptionId: subscription._id },
      { $set: { subscriptionStatus: SUBSCRIPTION_STATUS.EXPIRED } },
    );

    await subscriptionService.recordEvent(
      subscription.tenantId,
      subscription._id,
      'expired',
      gaveUpOnRenewal ? 'The subscription period ended and automatic renewal did not complete' : 'The subscription period ended',
      SYSTEM_ACTOR,
      { endedAt: subscription.currentPeriodEnd, ...(gaveUpOnRenewal ? { autoRenewSwitchedOff: true } : {}) },
    );
    if (gaveUpOnRenewal && subscription.renewWith === 'wallet' && !subscription.trialEndsAt) {
      await sendRenewalNotice({
        kind: 'auto_renew_stopped',
        tenantId: subscription.tenantId,
        planName: subscription.scheduledChange?.planName ?? subscription.planSnapshot?.name ?? 'your plan',
        periodEnd: subscription.currentPeriodEnd,
        reason: 'the grace period ended before a renewal went through',
      });
    }
    count += 1;
  }

  // Already expired (an entitlement read marks an ended period expired) but still
  // set to renew, with no renewal left to try: switch automatic renewal off.
  const stale = await SubscriptionModel.find({
    status: SUBSCRIPTION_STATUS.EXPIRED,
    autoRenew: true,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: { $lte: now },
  })
    .sort({ currentPeriodEnd: -1 })
    .limit(500)
    .lean<SubscriptionRecord[]>();
  for (const subscription of stale) {
    const walletRetrying =
      subscription.renewWith === 'wallet' &&
      (subscription.failedPaymentCount ?? 0) < RENEWAL_MAX_ATTEMPTS &&
      now.getTime() - subscription.currentPeriodEnd.getTime() < RENEWAL_GRACE_MS;
    if (walletRetrying || gatewayRenewalPending(subscription, now)) continue;
    const switched = await SubscriptionModel.updateOne({ _id: subscription._id, status: SUBSCRIPTION_STATUS.EXPIRED, autoRenew: true }, { $set: { autoRenew: false } });
    if (switched.modifiedCount === 0) continue;
    await subscriptionService.recordEvent(subscription.tenantId, subscription._id, 'auto_renew_changed', 'Automatic renewal switched off: the period ended without a renewal', SYSTEM_ACTOR, {
      enabled: false,
      reason: 'period_ended',
    });
    // Only recent wallet renewals are worth an email; very old records are just tidied.
    const recent = now.getTime() - subscription.currentPeriodEnd.getTime() < STALE_NOTICE_WINDOW_MS;
    const superseded = await SubscriptionModel.exists({ tenantId: subscription.tenantId, _id: { $gt: subscription._id } });
    if (recent && !superseded && subscription.renewWith === 'wallet' && !subscription.trialEndsAt) {
      await sendRenewalNotice({
        kind: 'auto_renew_stopped',
        tenantId: subscription.tenantId,
        planName: subscription.scheduledChange?.planName ?? subscription.planSnapshot?.name ?? 'your plan',
        periodEnd: subscription.currentPeriodEnd,
        reason: 'the grace period ended before a renewal went through',
      });
    }
  }

  if (count > 0) logger.info(`Expired ${count} lapsed subscription(s)`);
  return count;
}

/**
 * Automatic renewals that are NOT paid from the wallet.
 *
 * A gateway that supports recurring charges renews through the same renewal
 * core as the wallet (engine price, scheduled change, one charge per period,
 * a new period). Anything else - a manual transfer, a bank payment, a one-off
 * checkout - cannot be charged again without the owner: automatic renewal is
 * switched off ONCE, with one event and one notice, and the period then ends
 * normally. (Previously such subscriptions were marked past due and logged a
 * failure on every run.)
 */
export async function processRenewals(now = new Date()): Promise<number> {
  const due = await SubscriptionModel.find({
    status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.EXPIRED] },
    autoRenew: true,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: { $lte: now, $gte: new Date(now.getTime() - RENEWAL_GRACE_MS) },
    // Wallet renewals have their own pass (renewDueWalletSubscriptions).
    renewWith: { $ne: 'wallet' },
  })
    .sort({ currentPeriodEnd: 1 })
    .limit(200)
    .lean<SubscriptionRecord[]>();

  let renewed = 0;
  for (const subscription of due) {
    // Superseded by a newer period: the old one no longer renews.
    const superseded = await SubscriptionModel.exists({ tenantId: subscription.tenantId, _id: { $gt: subscription._id } });
    const provider = recurringProviderFor(subscription.provider);

    if (superseded || !provider || (subscription.failedPaymentCount ?? 0) >= RENEWAL_MAX_ATTEMPTS) {
      const switched = await SubscriptionModel.updateOne({ _id: subscription._id, autoRenew: true }, { $set: { autoRenew: false } });
      if (switched.modifiedCount === 0 || superseded) continue;
      await subscriptionService.recordEvent(
        subscription.tenantId,
        subscription._id,
        'auto_renew_changed',
        provider
          ? 'Automatic renewal switched off after repeated failures'
          : 'Automatic renewal is not available for this payment method - renew manually to keep using the POS',
        SYSTEM_ACTOR,
        { enabled: false, reason: provider ? 'attempts_exhausted' : 'not_supported', provider: subscription.provider },
      );
      if (!provider) {
        await sendRenewalNotice({
          kind: 'renewal_unavailable',
          tenantId: subscription.tenantId,
          planName: subscription.planSnapshot?.name ?? 'your plan',
          periodEnd: subscription.currentPeriodEnd,
        });
      }
      continue;
    }

    if ((await renewWithGateway(subscription, provider, now)) === 'renewed') renewed += 1;
  }

  if (renewed > 0) logger.info(`Renewed ${renewed} subscription(s) through a payment gateway`);
  return renewed;
}

let timer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;

/**
 * Simple in-process scheduler. Adequate for a single-instance deployment; swap
 * for an external scheduler (Agenda, BullMQ, cron) when running several nodes,
 * since every pass is idempotent and safe to move.
 */
export function startSubscriptionJobs(intervalMs = 60 * 60 * 1000, reconcileIntervalMs = 10 * 60 * 1000): void {
  const run = async () => {
    try {
      await sendExpiryReminders();
      await renewDueWalletSubscriptions();
      await processRenewals();
      await expireLapsedSubscriptions();
      await issueMissingInvoices();
      await issueMissingReceipts();
      await retryFailedEmails();
    } catch (error) {
      logger.error('Subscription job failed', error);
    }
  };

  // Gateway payments nobody returned to confirm: checked far more often than
  // renewals, because a customer who paid is waiting for their plan.
  const reconcile = async () => {
    try {
      const result = await reconcileStalePayments();
      if (result.checked > 0) logger.info('Reconciled stale gateway payments', result);
    } catch (error) {
      logger.error('Payment reconciliation failed', error);
    }
    // After reconciling, so a payment it just settled is not reported as stuck.
    try {
      const digest = await sendPaymentAlertDigest();
      if (digest.review + digest.stale > 0) logger.info('Payment alert digest', digest);
    } catch (error) {
      logger.error('Payment alert digest failed', error);
    }
  };

  void run();
  void reconcile();
  timer = setInterval(run, intervalMs);
  reconcileTimer = setInterval(reconcile, reconcileIntervalMs);
  // Never keep the process alive just for these timers.
  timer.unref?.();
  reconcileTimer.unref?.();
}

export function stopSubscriptionJobs(): void {
  if (timer) clearInterval(timer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  timer = null;
  reconcileTimer = null;
}
