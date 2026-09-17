import type { Types } from 'mongoose';
import { SUBSCRIPTION_STATUS } from '../../config/constants';
import { SubscriptionModel } from '../../models/Subscription';
import type { SubscriptionPlanDoc } from '../../models/SubscriptionPlan';
import { TenantModel } from '../../models/Tenant';
import { ApiError } from '../../utils/ApiError';
import { addInterval, buildPlanSnapshot } from './provisioning.service';
import { isPlanScopedElsewhere, verticalOfTenant } from './planEntitlements';
import { promoteToPrimary } from './primarySubscription';

const CLOSED_STATUSES = [SUBSCRIPTION_STATUS.EXPIRED, SUBSCRIPTION_STATUS.CANCELLED];

export interface OpenPeriodInput {
  tenantId: Types.ObjectId;
  plan: SubscriptionPlanDoc & { _id: Types.ObjectId };
  /** `active` unless a platform admin assigns a trial. */
  status?: string;
  /** Explicit period; otherwise `periods` billing intervals from the start. */
  start?: Date;
  end?: Date;
  periods?: number;
  /**
   * Renewing the SAME plan early continues from the end of the running period
   * instead of discarding the time already paid for. A different plan starts now.
   */
  stackOnSamePlan?: boolean;
  autoRenew: boolean;
  provider: string;
  isManual: boolean;
  activatedBy?: Types.ObjectId | null;
  notes?: string;
  lastPaymentId?: Types.ObjectId | null;
  /** The price the customer was quoted (pricing engine). Recorded on the subscription instead of the plan's stored price. */
  priceMinor?: number;
  currency?: string;
}

/**
 * THE way a subscription period is opened, whatever paid for it: a confirmed
 * gateway payment, an approved manual or wallet upgrade, or a platform admin
 * assignment. One implementation, so "only one subscription is live" and "the
 * workspace record matches it" hold everywhere.
 *
 * The new period is created FIRST, then every OLDER live subscription is
 * closed. Closing only older ones means two activations racing for the same
 * workspace cannot close each other: the newest always survives, and there is
 * never a moment with no live subscription.
 */
export async function openSubscriptionPeriod(input: OpenPeriodInput) {
  const now = new Date();
  const vertical = await verticalOfTenant(input.tenantId);
  // Last line of defence behind every payment path: a plan sold for one POS
  // type never opens a period in a workspace of another.
  if (isPlanScopedElsewhere(input.plan, vertical)) {
    throw ApiError.badRequest(`${input.plan.name} is not offered for ${vertical} workspaces.`, {
      planCode: input.plan.code,
      vertical,
    });
  }

  let start = input.start ?? now;
  if (!input.start && input.stackOnSamePlan) {
    const live = await SubscriptionModel.findOne({ tenantId: input.tenantId, status: { $nin: CLOSED_STATUSES } })
      .sort({ createdAt: -1 })
      .lean();
    if (live && live.planSnapshot?.code === input.plan.code && live.currentPeriodEnd > now) start = live.currentPeriodEnd;
  }

  let end = input.end;
  if (!end) {
    end = start;
    for (let i = 0; i < Math.max(1, input.periods ?? 1); i += 1) end = addInterval(end, input.plan.interval);
  }
  if (end <= start) throw ApiError.badRequest('The subscription must end after it starts');

  const status = input.status ?? SUBSCRIPTION_STATUS.ACTIVE;
  const subscription = await SubscriptionModel.create({
    tenantId: input.tenantId,
    planId: input.plan._id,
    planSnapshot: buildPlanSnapshot(
      input.plan,
      vertical,
      input.priceMinor !== undefined ? { priceMinor: input.priceMinor, currency: input.currency ?? input.plan.currency } : undefined,
    ),
    status,
    startedAt: input.start ?? now,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    trialEndsAt: status === SUBSCRIPTION_STATUS.TRIAL ? end : null,
    autoRenew: input.autoRenew,
    provider: input.provider,
    isManual: input.isManual,
    activatedBy: input.activatedBy ?? null,
    notes: input.notes ?? '',
    lastPaymentId: input.lastPaymentId ?? null,
  });

  // The new period becomes the workspace's primary subscription (unless a newer one already has).
  const promoted = await promoteToPrimary(input.tenantId, subscription._id);
  subscription.set('isPrimary', promoted);
  subscription.unmarkModified('isPrimary');
  if (!promoted) {
    // A newer period was opened concurrently and may have closed older ones
    // before this one was written, so this one closes itself: the newest wins.
    await SubscriptionModel.updateOne(
      { _id: subscription._id, status: { $nin: CLOSED_STATUSES } },
      { $set: { status: SUBSCRIPTION_STATUS.EXPIRED, autoRenew: false } },
    );
    subscription.set({ status: SUBSCRIPTION_STATUS.EXPIRED, autoRenew: false });
    subscription.unmarkModified('status');
    subscription.unmarkModified('autoRenew');
  }

  await SubscriptionModel.updateMany(
    { tenantId: input.tenantId, _id: { $lt: subscription._id }, status: { $nin: CLOSED_STATUSES } },
    { $set: { status: SUBSCRIPTION_STATUS.EXPIRED, autoRenew: false } },
  );

  // Only move the workspace's denormalised pointer forward, never back to an older period.
  await TenantModel.updateOne(
    { _id: input.tenantId, $or: [{ currentSubscriptionId: null }, { currentSubscriptionId: { $lt: subscription._id } }] },
    { $set: { subscriptionStatus: status, currentSubscriptionId: subscription._id, subscriptionEndsAt: end } },
  );

  return subscription;
}
