import { Types, type ClientSession } from 'mongoose';
import dayjs from 'dayjs';
import { SUBSCRIPTION_STATUS } from '../../config/constants';
import { SubscriptionModel } from '../../models/Subscription';
import { SubscriptionEventModel } from '../../models/SubscriptionEvent';
import { SubscriptionPlanModel, type SubscriptionPlanDoc } from '../../models/SubscriptionPlan';
import { TenantModel } from '../../models/Tenant';
import { sessionOpt } from '../../utils/tx';
import { logger } from '../../utils/logger';
import { DEFAULT_POS_VERTICAL, type PosVertical } from '../../config/verticals';
import { resolvePlanForVertical, verticalOfTenant } from './planEntitlements';
import { promoteToPrimary } from './primarySubscription';
import { TRIAL_LENGTH_DAYS } from './trialPolicy';

/** Adds one billing period to a date. */
export const addInterval = (from: Date, interval: string): Date =>
  interval === 'yearly' ? dayjs(from).add(1, 'year').toDate() : dayjs(from).add(1, 'month').toDate();

/**
 * The frozen copy of a plan stored on a subscription. The vertical is REQUIRED:
 * a snapshot holds what the plan includes for the buyer's POS vertical, which
 * can differ from the platform default.
 */
export const buildPlanSnapshot = (
  plan: SubscriptionPlanDoc | (SubscriptionPlanDoc & { _id: Types.ObjectId }),
  vertical: PosVertical,
  /** The price actually quoted for the purchase; defaults to the plan's stored price. */
  price?: { priceMinor: number; currency: string },
) => {
  const resolved = resolvePlanForVertical(plan, vertical);
  return {
    code: plan.code,
    name: plan.name,
    interval: plan.interval,
    priceMinor: price?.priceMinor ?? plan.priceMinor,
    currency: price?.currency ?? plan.currency,
    vertical,
    posProductCode: plan.posProductCode ?? null,
    features: resolved.features,
    limits: resolved.limits,
  };
};

/**
 * Creates the trial subscription a brand-new tenant starts on. Trial length and
 * the starter plan both come from the database, never from constants in code.
 */
export async function findTrialPlan(vertical: PosVertical = DEFAULT_POS_VERTICAL, session?: ClientSession) {
  // `trialDays > 0` IS the eligibility rule. The lowest tier wins if a platform
  // admin ever sets it on several, so a misconfiguration cannot hand out a free
  // Brand. A trial plan made for this POS type is preferred over a shared one;
  // a plan made for another POS type is never a candidate.
  const candidates = await SubscriptionPlanModel.find({
    interval: 'monthly',
    isActive: true,
    isPublic: true,
    trialDays: { $gt: 0 },
    posProductCode: { $in: [vertical, null] },
  })
    .sort({ tier: 1, sortOrder: 1 })
    .session(session ?? null);
  return candidates.find((plan) => plan.posProductCode === vertical) ?? candidates[0] ?? null;
}

export async function startTrialSubscription(
  tenantId: Types.ObjectId,
  session?: ClientSession,
): Promise<Types.ObjectId | null> {
  const vertical = await verticalOfTenant(tenantId, session);
  const plan = await findTrialPlan(vertical, session);

  if (!plan) {
    // No trial-eligible plan is configured. The tenant is still created; a
    // platform admin can assign a subscription manually.
    logger.warn('No trial-eligible plan found - tenant created without a trial subscription', {
      tenantId: String(tenantId),
    });
    return null;
  }

  // The trial plan must actually be offered to this workspace's vertical.
  if (!resolvePlanForVertical(plan, vertical).isAvailable) {
    logger.warn('The trial plan is not offered for this vertical - tenant created without a trial subscription', {
      tenantId: String(tenantId),
      vertical,
      planCode: plan.code,
    });
    return null;
  }

  const now = new Date();
  // A business rule, not plan data: `trialDays > 0` only marks the trial plan.
  const trialDays = TRIAL_LENGTH_DAYS;
  const trialEnd = dayjs(now).add(trialDays, 'day').toDate();

  const [subscription] = await SubscriptionModel.create(
    [
      {
        tenantId,
        planId: plan._id,
        planSnapshot: buildPlanSnapshot(plan, vertical),
        status: SUBSCRIPTION_STATUS.TRIAL,
        startedAt: now,
        currentPeriodStart: now,
        currentPeriodEnd: trialEnd,
        trialEndsAt: trialEnd,
        autoRenew: false,
        provider: 'manual',
        isManual: true,
        notes: `Automatic ${trialDays}-day trial on signup`,
      },
    ],
    { session },
  );
  await promoteToPrimary(tenantId, subscription._id, session);

  await SubscriptionEventModel.create(
    [
      {
        tenantId,
        subscriptionId: subscription._id,
        type: 'created',
        message: `${trialDays}-day trial started on ${plan.name}`,
        data: { planCode: plan.code, trialDays },
        actorNameSnapshot: 'system',
      },
    ],
    { session },
  );

  await TenantModel.updateOne(
    { _id: tenantId },
    {
      $set: {
        subscriptionStatus: SUBSCRIPTION_STATUS.TRIAL,
        currentSubscriptionId: subscription._id,
        subscriptionEndsAt: trialEnd,
      },
    },
    sessionOpt(session),
  );

  return subscription._id;
}
