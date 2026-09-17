import type { Types } from 'mongoose';
import { PAYMENT_STATUS, SUBSCRIPTION_STATUS } from '../../config/constants';
import { AccountModel } from '../../models/Account';
import { AuditLogModel } from '../../models/AuditLog';
import { PaymentModel } from '../../models/Payment';
import { PRIMARY_FIRST, SubscriptionModel, type SubscriptionDoc } from '../../models/Subscription';
import { SubscriptionEventModel } from '../../models/SubscriptionEvent';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { TenantModel } from '../../models/Tenant';
import { planChangeService } from '../../modules/subscriptions/planChange.service';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { issueInvoiceSafely } from '../billing/invoice.service';
import type { PaymentProvider } from '../payment/PaymentProvider';
import { walletService } from '../wallet/wallet.service';
import { openSubscriptionPeriod } from './activation.service';
import { offerForPlan, pricingRecordOf } from './purchasePricing.service';
import { sendRenewalNotice } from './renewalNotices.service';
import {
  LATE_RENEWAL_RESTART_MS,
  RENEWAL_GRACE_MS,
  RENEWAL_MAX_ATTEMPTS,
  RENEWAL_RETRY_MS,
  RENEWAL_WINDOW_MS,
} from './renewalPolicy';

type SubscriptionRecord = SubscriptionDoc & { _id: Types.ObjectId };

/** The job's summary of one attempt. */
export type RenewalOutcome = 'renewed' | 'failed' | 'skipped';
export type RenewalTrigger = 'automatic' | 'manual';

/** The billing state a renewal ends in - what the caller shows the owner. */
export type RenewalState = 'renewed' | 'already_renewed' | 'insufficient_funds' | 'failed' | 'in_progress' | 'not_due' | 'not_renewable';

export interface RenewalResult {
  state: RenewalState;
  subscriptionId: Types.ObjectId;
  /** The new period, when one was opened (or already had been). */
  renewedSubscriptionId: Types.ObjectId | null;
  planName: string | null;
  /** The price charged, or that would have been: always the pricing engine's, never a client's. */
  amountMinor: number | null;
  currency: string | null;
  walletBalanceMinor: number | null;
  /** The end of the renewed period, or of the unchanged one. */
  currentPeriodEnd: Date | null;
  message: string;
}

interface Actor {
  id: Types.ObjectId | null;
  name: string;
}

const SYSTEM = 'automatic renewal';
const SYSTEM_ACTOR: Actor = { id: null, name: SYSTEM };
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;
const isInsufficientFunds = (error: unknown) =>
  error instanceof ApiError && typeof (error.details as { requiredMinor?: unknown } | undefined)?.requiredMinor === 'number';

interface Charged {
  providerReference: string | null;
  providerTransactionId: string | null;
  /** Gives the money back when the renewal cannot be completed after charging. */
  undo(): Promise<void>;
}

/** How a renewal is paid for. The renewal rules around it are the same for every charger. */
interface RenewalCharger {
  provider: string;
  charge(input: { subscription: SubscriptionRecord; planId: Types.ObjectId; planName: string; amountMinor: number; currency: string; operationKey: string }): Promise<Charged>;
  /** Carried onto the new period so it keeps renewing the same way. */
  nextPeriodFields(subscription: SubscriptionRecord, trigger: RenewalTrigger): Record<string, unknown>;
}

const NOTHING_TAKEN: Charged = { providerReference: null, providerTransactionId: null, undo: async () => undefined };

const walletCharger: RenewalCharger = {
  provider: 'wallet',
  async charge({ subscription, planName, amountMinor, operationKey }) {
    if (amountMinor <= 0) return NOTHING_TAKEN;
    // Keyed: a retry of this exact attempt can never debit twice.
    const movement = await walletService.debit(subscription.tenantId, {
      amountMinor,
      reason: `Subscription renewal: ${planName}`,
      referenceType: 'subscription',
      referenceId: subscription._id,
      performedBy: null,
      performedByName: SYSTEM,
      source: 'subscription',
      idempotencyKey: operationKey,
    });
    return {
      providerReference: `WALLET-${movement.transaction._id}`,
      providerTransactionId: null,
      // A compensating reversal, linked to the debit - never an edit.
      undo: async () => {
        await walletService.reverse(movement.transaction._id, { reason: 'The renewal could not be completed', performedBy: null, performedByName: SYSTEM });
      },
    };
  },
  nextPeriodFields: (subscription, trigger) => ({ renewWith: trigger === 'automatic' || subscription.renewWith === 'wallet' ? 'wallet' : null }),
};

/** A gateway that supports recurring charges (none of the bundled providers do today). */
function gatewayCharger(provider: PaymentProvider): RenewalCharger {
  return {
    provider: provider.name,
    async charge({ subscription, planId, amountMinor, currency }) {
      if (!provider.chargeRecurring) throw ApiError.badRequest(`${provider.displayName} cannot renew automatically`);
      if (amountMinor <= 0) return NOTHING_TAKEN;
      const result = await provider.chargeRecurring({
        tenantId: subscription.tenantId,
        userId: null,
        subscriptionId: subscription._id,
        planId,
        amountMinor,
        currency,
        providerSubscriptionId: subscription.providerSubscriptionId ?? '',
      });
      if (result.status !== 'paid') throw new Error(result.failureReason ?? 'The renewal charge was not completed');
      return {
        providerReference: null,
        providerTransactionId: result.providerTransactionId ?? null,
        undo: async () => {
          if (!provider.refund || !result.providerTransactionId) throw new Error(`${provider.displayName} cannot refund automatically`);
          const refund = await provider.refund(result.providerTransactionId, amountMinor);
          if (String(refund.status) === 'failed') throw new Error(refund.failureReason ?? 'The refund failed');
        },
      };
    },
    nextPeriodFields: (subscription) => ({ providerSubscriptionId: subscription.providerSubscriptionId ?? null }),
  };
}

const balanceOf = (tenantId: Types.ObjectId) =>
  walletService
    .balance(tenantId)
    .then((wallet) => wallet.balanceMinor)
    .catch(() => null);

/** One period is paid for once, whatever renews it (the job, the owner, a retry). */
const periodKeyOf = (subscription: Pick<SubscriptionRecord, '_id' | 'currentPeriodEnd'>) => `renewal:${String(subscription._id)}:${subscription.currentPeriodEnd.toISOString()}`;

async function audit(action: string, actor: Actor, trigger: RenewalTrigger, tenantId: Types.ObjectId, label: string, value: Record<string, unknown>) {
  try {
    await AuditLogModel.create({
      actorId: actor.id,
      actorNameSnapshot: actor.name,
      actorRole: trigger === 'manual' ? 'account_owner' : 'system',
      action,
      targetTenantId: tenantId,
      targetLabel: label,
      newValue: { trigger, ...value },
    });
  } catch (error) {
    logger.error('Recording a renewal in the audit log failed', { action, error: error instanceof Error ? error.message : 'unknown' });
  }
}

// ------------------------------------------------------------------ entry points

/**
 * THE renewal: renews one subscription from the account wallet.
 *
 *   1. validate    the subscription is the workspace's current one, not
 *                  cancelled or suspended, and due (manual: within the renewal
 *                  window or already ended)
 *   2. price       workspace -> POS product -> plan (or the scheduled change)
 *                  -> billing cycle -> the pricing engine's active price NOW
 *   3. ownership   the wallet charged is the one of the workspace's account
 *   4. once        a claim on the subscription, and one payment per period
 *   5. debit       one atomic, keyed wallet debit and its ledger row
 *   6. period      a NEW subscription period, continuing from the old end
 *   7. records     payment, invoice, subscription event and audit log entry
 *
 * No amount is ever accepted from outside. Nothing is partly done: if the
 * wallet cannot pay, nothing is debited and the period is not extended; if
 * something fails after the debit, the debit is reversed. Other workspaces of
 * the account are never touched.
 */
export async function renewSubscription(
  subscriptionId: Types.ObjectId,
  options: { trigger?: RenewalTrigger; actor?: Actor; now?: Date } = {},
): Promise<RenewalResult> {
  const trigger = options.trigger ?? 'manual';
  const now = options.now ?? new Date();
  const actor = options.actor ?? SYSTEM_ACTOR;

  const subscription = await SubscriptionModel.findById(subscriptionId).lean<SubscriptionRecord>();
  if (!subscription) {
    return { state: 'not_renewable', subscriptionId, renewedSubscriptionId: null, planName: null, amountMinor: null, currency: null, walletBalanceMinor: null, currentPeriodEnd: null, message: 'Subscription not found' };
  }

  const refusal = await renewalRefusal(subscription, trigger, now);
  if (refusal) {
    return {
      state: refusal.state,
      subscriptionId,
      renewedSubscriptionId: refusal.renewedSubscriptionId ?? null,
      planName: subscription.planSnapshot?.name ?? null,
      amountMinor: null,
      currency: null,
      walletBalanceMinor: await balanceOf(subscription.tenantId),
      currentPeriodEnd: subscription.currentPeriodEnd,
      message: refusal.message,
    };
  }
  return runRenewal(subscription, walletCharger, now, trigger, actor);
}

/** Renews a workspace's current subscription. */
export async function renewWorkspaceSubscription(tenantId: Types.ObjectId, options: { trigger?: RenewalTrigger; actor?: Actor; now?: Date } = {}) {
  const current = await SubscriptionModel.findOne({ tenantId }).sort(PRIMARY_FIRST).select('_id').lean();
  if (!current) throw ApiError.notFound('This workspace has no subscription to renew');
  return renewSubscription(current._id, options);
}

async function renewalRefusal(
  subscription: SubscriptionRecord,
  trigger: RenewalTrigger,
  now: Date,
): Promise<{ state: RenewalState; message: string; renewedSubscriptionId?: Types.ObjectId | null } | null> {
  const [workspace, newer] = await Promise.all([
    TenantModel.findById(subscription.tenantId).select('status accountId').lean(),
    SubscriptionModel.exists({ tenantId: subscription.tenantId, _id: { $gt: subscription._id } }),
  ]);
  if (!workspace) return { state: 'not_renewable', message: 'The workspace no longer exists' };
  if (newer) {
    const paid = await PaymentModel.findOne({ idempotencyKey: periodKeyOf(subscription) }).select('subscriptionId').lean();
    return paid
      ? { state: 'already_renewed', message: 'This period has already been renewed', renewedSubscriptionId: paid.subscriptionId ?? null }
      : { state: 'not_renewable', message: 'A newer subscription period has replaced this one' };
  }
  if (workspace.status === 'suspended' || subscription.status === SUBSCRIPTION_STATUS.SUSPENDED) {
    return { state: 'not_renewable', message: 'This workspace is suspended. Please contact support.' };
  }
  if (workspace.accountId) {
    const account = await AccountModel.findById(workspace.accountId).select('status').lean();
    if (!account || account.status === 'suspended') return { state: 'not_renewable', message: 'This account is suspended. Please contact support.' };
    // The money must come from THIS workspace's account wallet.
    const wallet = await walletService.getOrCreate(subscription.tenantId);
    if (!wallet.accountId || !wallet.accountId.equals(workspace.accountId)) {
      return { state: 'not_renewable', message: "The wallet does not belong to this workspace's account" };
    }
  }
  if (subscription.cancelAtPeriodEnd || subscription.cancelledAt) {
    return { state: 'not_renewable', message: 'This subscription was cancelled. Resume it or choose a plan instead of renewing.' };
  }
  const remaining = subscription.currentPeriodEnd.getTime() - now.getTime();
  if (remaining > 0 && (trigger === 'automatic' || remaining > RENEWAL_WINDOW_MS)) {
    return { state: 'not_due', message: `Renewal opens in the last 7 days before ${subscription.currentPeriodEnd.toISOString().slice(0, 10)}` };
  }
  return null;
}

/**
 * Renews every subscription set to renew from the wallet whose period has
 * ended (within the grace window). Safe to run as often as wanted, from any
 * number of processes: each renewal is claimed, and each period can be paid
 * for at most once.
 */
export async function renewDueWalletSubscriptions(now = new Date()) {
  const due = await SubscriptionModel.find({
    renewWith: 'wallet',
    autoRenew: true,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: { $lte: now, $gte: new Date(now.getTime() - RENEWAL_GRACE_MS) },
    // `expired` is included because reading an entitlement lazily marks an ended trial expired.
    status: { $in: [SUBSCRIPTION_STATUS.TRIAL, SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.EXPIRED] },
    failedPaymentCount: { $lt: RENEWAL_MAX_ATTEMPTS },
  })
    .sort({ currentPeriodEnd: 1 })
    .limit(200)
    .lean<SubscriptionRecord[]>();

  const result = { renewed: 0, failed: 0, skipped: 0 };
  // One at a time and independently: a workspace that cannot pay never affects another.
  for (const subscription of due) result[await renewWithWallet(subscription, now)] += 1;
  if (result.renewed + result.failed > 0) logger.info('Wallet renewals processed', result);
  return result;
}

type RenewalCandidate = Pick<SubscriptionRecord, '_id' | 'tenantId' | 'lastRenewalAttemptAt'>;

const toOutcome = (result: RenewalResult): RenewalOutcome =>
  result.state === 'renewed' ? 'renewed' : result.state === 'insufficient_funds' || result.state === 'failed' ? 'failed' : 'skipped';

export const renewWithWallet = async (subscription: RenewalCandidate, now = new Date()) => toOutcome(await runRenewal(subscription, walletCharger, now, 'automatic', SYSTEM_ACTOR));
export const renewWithGateway = async (subscription: RenewalCandidate, provider: PaymentProvider, now = new Date()) =>
  toOutcome(await runRenewal(subscription, gatewayCharger(provider), now, 'automatic', SYSTEM_ACTOR));

// ------------------------------------------------------------------ the core

async function runRenewal(subscription: RenewalCandidate, charger: RenewalCharger, now: Date, trigger: RenewalTrigger, actor: Actor): Promise<RenewalResult> {
  const result = (state: RenewalState, message: string, extra: Partial<RenewalResult> = {}): RenewalResult => ({
    state,
    subscriptionId: subscription._id,
    renewedSubscriptionId: null,
    planName: null,
    amountMinor: null,
    currency: null,
    walletBalanceMinor: null,
    currentPeriodEnd: null,
    message,
    ...extra,
  });

  const last = subscription.lastRenewalAttemptAt ?? null;
  if (trigger === 'automatic' && last && now.getTime() - last.getTime() < RENEWAL_RETRY_MS) return result('in_progress', 'Tried too recently');

  // Superseded by a newer period (the customer bought something): nothing to renew.
  if (await SubscriptionModel.exists({ tenantId: subscription.tenantId, _id: { $gt: subscription._id } })) {
    return result('not_renewable', 'A newer subscription period has replaced this one');
  }

  // Claim this attempt: of any number of concurrent attempts, exactly one proceeds.
  const claimed = await SubscriptionModel.findOneAndUpdate(
    { _id: subscription._id, cancelAtPeriodEnd: false, lastRenewalAttemptAt: last, ...(trigger === 'automatic' ? { autoRenew: true } : {}) },
    { $set: { lastRenewalAttemptAt: now } },
    { new: true },
  ).lean<SubscriptionRecord>();
  if (!claimed) return result('in_progress', 'Another renewal of this subscription is already in progress');

  const periodKey = periodKeyOf(claimed);
  const alreadyPaid = await PaymentModel.findOne({ idempotencyKey: periodKey }).select('subscriptionId amountMinor currency').lean();
  if (alreadyPaid) {
    return result('already_renewed', 'This period has already been renewed', {
      renewedSubscriptionId: alreadyPaid.subscriptionId ?? null,
      amountMinor: alreadyPaid.amountMinor,
      currency: alreadyPaid.currency,
    });
  }

  const targetPlanId = claimed.scheduledChange?.planId ?? claimed.planId;
  let planName = claimed.scheduledChange?.planName ?? claimed.planSnapshot?.name ?? 'your plan';
  let quoted: { amountMinor: number; currency: string } | null = null;
  let charged: Charged | null = null;
  let paymentId: Types.ObjectId | null = null;

  try {
    const plan = await SubscriptionPlanModel.findOne({ _id: targetPlanId, isActive: true });
    if (!plan) throw ApiError.badRequest('The plan to renew into is no longer available');
    planName = plan.name;

    // The same plan-change rules as a purchase, and the engine's price for this workspace's POS type.
    await planChangeService.assertAllowed(claimed.tenantId, plan._id);
    const offer = await offerForPlan(claimed.tenantId, plan);
    const amountMinor = offer.listPriceMinor;
    quoted = { amountMinor, currency: offer.currency };

    charged = await charger.charge({
      subscription: claimed,
      planId: plan._id,
      planName: plan.name,
      amountMinor,
      currency: offer.currency,
      operationKey: `${periodKey}:${now.getTime()}`,
    });

    const payment = await PaymentModel.create({
      tenantId: claimed.tenantId,
      planId: plan._id,
      amountMinor,
      currency: offer.currency,
      provider: charger.provider,
      providerReference: charged.providerReference,
      providerTransactionId: charged.providerTransactionId,
      status: PAYMENT_STATUS.PAID,
      paidAt: now,
      idempotencyKey: periodKey,
      metadata: { autoRenewal: trigger === 'automatic', renewal: true, trigger, renewalOf: String(claimed._id), pricing: pricingRecordOf(offer), prorationCreditAppliedMinor: 0 },
    });
    paymentId = payment._id;

    const late = now.getTime() - claimed.currentPeriodEnd.getTime() > LATE_RENEWAL_RESTART_MS;
    const next = await openSubscriptionPeriod({
      tenantId: claimed.tenantId,
      plan,
      start: late ? now : claimed.currentPeriodEnd,
      periods: 1,
      autoRenew: trigger === 'automatic' ? true : claimed.autoRenew,
      provider: charger.provider,
      isManual: false,
      lastPaymentId: payment._id,
      notes: trigger === 'automatic' ? `Automatic renewal (${charger.provider})` : `Renewed by ${actor.name}`,
      priceMinor: amountMinor,
      currency: offer.currency,
    });
    await SubscriptionModel.updateOne({ _id: next._id }, { $set: charger.nextPeriodFields(claimed, trigger) });
    await PaymentModel.updateOne({ _id: payment._id }, { $set: { subscriptionId: next._id } });
    await issueInvoiceSafely(payment._id);

    const changed = String(plan._id) !== String(claimed.planId);
    await SubscriptionEventModel.create([
      {
        tenantId: claimed.tenantId,
        subscriptionId: next._id,
        type: 'renewed',
        message: trigger === 'automatic' ? `Renewed automatically (${charger.provider}): ${plan.name}` : `Renewed by ${actor.name}: ${plan.name}`,
        data: { paymentId: String(payment._id), amountMinor, currency: offer.currency, previousSubscriptionId: String(claimed._id), trigger },
        actorId: actor.id,
        actorNameSnapshot: actor.name,
      },
      ...(changed
        ? [
            {
              tenantId: claimed.tenantId,
              subscriptionId: next._id,
              type: 'plan_changed',
              message: `Scheduled change applied at renewal: ${claimed.planSnapshot?.name ?? 'previous plan'} → ${plan.name}`,
              data: { from: claimed.planSnapshot?.code ?? null, to: plan.code },
              actorId: claimed.scheduledChange?.requestedBy ?? null,
              actorNameSnapshot: claimed.scheduledChange?.requestedByNameSnapshot || SYSTEM,
            },
          ]
        : []),
    ]);
    await audit('subscription.renewed', actor, trigger, claimed.tenantId, plan.name, {
      subscriptionId: String(claimed._id),
      renewedSubscriptionId: String(next._id),
      paymentId: String(payment._id),
      amountMinor,
      currency: offer.currency,
    });

    return result('renewed', `${plan.name} renewed until ${next.currentPeriodEnd.toISOString().slice(0, 10)}`, {
      renewedSubscriptionId: next._id,
      planName: plan.name,
      amountMinor,
      currency: offer.currency,
      walletBalanceMinor: await balanceOf(claimed.tenantId),
      currentPeriodEnd: next.currentPeriodEnd,
    });
  } catch (error) {
    // Nothing was activated: put back what was taken.
    if (paymentId) await PaymentModel.deleteOne({ _id: paymentId, subscriptionId: null });
    let refundFailed = false;
    if (charged) {
      await charged.undo().catch((undoError: unknown) => {
        refundFailed = true;
        // Money owed to a customer: loud.
        logger.error('Returning the money for a failed renewal failed', {
          tenantId: String(claimed.tenantId),
          subscriptionId: String(claimed._id),
          provider: charger.provider,
          amountMinor: quoted?.amountMinor,
          error: undoError instanceof Error ? undoError.message : 'unknown',
        });
      });
    }
    // Another process paid for this period at the same moment: not a failure.
    if (isDuplicateKey(error)) return result('already_renewed', 'This period has already been renewed', { planName, amountMinor: quoted?.amountMinor ?? null, currency: quoted?.currency ?? null });

    const insufficient = isInsufficientFunds(error);
    const reason = error instanceof Error ? error.message : 'The renewal could not be completed';
    const walletBalanceMinor = await balanceOf(claimed.tenantId);
    const failure = (message: string) =>
      result(insufficient ? 'insufficient_funds' : 'failed', message, {
        planName,
        amountMinor: quoted?.amountMinor ?? null,
        currency: quoted?.currency ?? null,
        walletBalanceMinor,
        currentPeriodEnd: claimed.currentPeriodEnd,
      });

    if (trigger === 'manual') {
      // An owner's attempt changes nothing about the subscription: no attempt
      // counted, no status change, and the automatic retry schedule is restored.
      await SubscriptionModel.updateOne({ _id: claimed._id, lastRenewalAttemptAt: now }, { $set: { lastRenewalAttemptAt: last } });
      await SubscriptionEventModel.create({
        tenantId: claimed.tenantId,
        subscriptionId: claimed._id,
        type: 'renewal_failed',
        message: `Renewal by ${actor.name} failed: ${reason}`,
        data: { trigger, insufficientFunds: insufficient, amountMinor: quoted?.amountMinor ?? null, ...(refundFailed ? { refundFailed: true } : {}) },
        actorId: actor.id,
        actorNameSnapshot: actor.name,
      });
      await audit('subscription.renewal_failed', actor, trigger, claimed.tenantId, planName, { subscriptionId: String(claimed._id), reason, insufficientFunds: insufficient, amountMinor: quoted?.amountMinor ?? null });
      return failure(insufficient ? `The wallet does not cover this renewal. ${reason}` : reason);
    }

    const attempts = (claimed.failedPaymentCount ?? 0) + 1;
    const final = attempts >= RENEWAL_MAX_ATTEMPTS;
    const status = final ? SUBSCRIPTION_STATUS.EXPIRED : SUBSCRIPTION_STATUS.PAST_DUE;
    await SubscriptionModel.updateOne(
      { _id: claimed._id },
      { $set: { failedPaymentCount: attempts, status, ...(final ? { autoRenew: false } : {}) } },
    );
    await TenantModel.updateOne({ _id: claimed.tenantId, currentSubscriptionId: claimed._id }, { $set: { subscriptionStatus: status } });
    await SubscriptionEventModel.create({
      tenantId: claimed.tenantId,
      subscriptionId: claimed._id,
      type: 'renewal_failed',
      message: final ? `Automatic renewal failed ${attempts} times and has been switched off: ${reason}` : `Automatic renewal failed: ${reason}`,
      data: { attempt: attempts, final, provider: charger.provider, trigger, insufficientFunds: insufficient, ...(refundFailed ? { refundFailed: true } : {}) },
      actorId: null,
      actorNameSnapshot: SYSTEM,
    });
    await audit('subscription.renewal_failed', actor, trigger, claimed.tenantId, planName, { subscriptionId: String(claimed._id), reason, attempt: attempts, final, insufficientFunds: insufficient });

    const graceEnds = new Date(claimed.currentPeriodEnd.getTime() + RENEWAL_GRACE_MS);
    await sendRenewalNotice({
      kind: final ? 'auto_renew_stopped' : 'renewal_failed',
      tenantId: claimed.tenantId,
      planName,
      periodEnd: claimed.currentPeriodEnd,
      amountMinor: quoted?.amountMinor ?? null,
      currency: quoted?.currency ?? null,
      reason,
      attempt: attempts,
      // Only a paid wallet subscription keeps working while renewal is retried.
      graceEndsAt: !final && charger.provider === 'wallet' && !claimed.trialEndsAt && graceEnds > now ? graceEnds : null,
    });
    return failure(reason);
  }
}
