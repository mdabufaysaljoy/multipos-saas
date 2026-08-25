import { Types, type ClientSession } from 'mongoose';
import dayjs from 'dayjs';
import { SUBSCRIPTION_STATUS } from '../../config/constants';
import { env } from '../../config/env';
import { SubscriptionModel } from '../../models/Subscription';
import { SubscriptionEventModel } from '../../models/SubscriptionEvent';
import { SubscriptionPlanModel, type SubscriptionPlanDoc } from '../../models/SubscriptionPlan';
import { TenantModel } from '../../models/Tenant';
import { sessionOpt } from '../../utils/tx';
import { logger } from '../../utils/logger';

/** Adds one billing period to a date. */
export const addInterval = (from: Date, interval: string): Date =>
  interval === 'yearly' ? dayjs(from).add(1, 'year').toDate() : dayjs(from).add(1, 'month').toDate();

export const buildPlanSnapshot = (plan: SubscriptionPlanDoc | (SubscriptionPlanDoc & { _id: Types.ObjectId })) => ({
  code: plan.code,
  name: plan.name,
  interval: plan.interval,
  priceMinor: plan.priceMinor,
  currency: plan.currency,
  features: plan.features,
  limits: plan.limits,
});

/**
 * Creates the trial subscription a brand-new tenant starts on. Trial length and
 * the starter plan both come from the database, never from constants in code.
 */
export async function startTrialSubscription(
  tenantId: Types.ObjectId,
  session?: ClientSession,
): Promise<Types.ObjectId | null> {
  const plan = await SubscriptionPlanModel.findOne({ interval: 'monthly', isActive: true })
    .sort({ sortOrder: 1 })
    .session(session ?? null);

  if (!plan) {
    // Plans have not been seeded. The tenant is still created; a platform admin
    // can assign a subscription manually.
    logger.warn('No active monthly plan found - tenant created without a trial subscription', { tenantId: String(tenantId) });
    return null;
  }

  const now = new Date();
  const trialDays = plan.trialDays > 0 ? plan.trialDays : env.TRIAL_DAYS;
  const trialEnd = dayjs(now).add(trialDays, 'day').toDate();

  const [subscription] = await SubscriptionModel.create(
    [
      {
        tenantId,
        planId: plan._id,
        planSnapshot: buildPlanSnapshot(plan),
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
