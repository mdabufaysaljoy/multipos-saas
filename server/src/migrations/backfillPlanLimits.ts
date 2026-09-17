/**
 * Backfills the plan limits and feature flags introduced with the MVP package
 * structure: maxMonthlySales, maxCustomers, maxStorageBytes, smsMarketing,
 * emailMarketing and imageOptimization.
 *
 * Only keys that are MISSING are written. Changing the VALUE of a limit an
 * existing customer already bought is a commercial decision, not a migration:
 * re-run `npm run seed -w server` to update the plan catalogue, and existing
 * subscriptions adopt the new numbers when they next renew.
 *
 * Two collections need it:
 *
 *   1. `subscriptionplans` - the editable catalogue. Re-running the seed also
 *      fixes these, but the seed rewrites prices and copy too, which a live
 *      platform may have customised. This touches only the missing keys.
 *
 *   2. `subscriptions.planSnapshot` - frozen at purchase. A snapshot taken
 *      before these fields existed has no value for them, so the entitlement
 *      service falls back to "unlimited" for limits and "off" for features.
 *      That is safe but wrong: a paying Showroom customer would lose marketing
 *      until they renewed. Here we copy the values from the plan they bought,
 *      matched on the snapshot's plan code.
 *
 * Idempotent: only documents actually missing a key are written.
 *
 * Run with:  npm run migrate:plan-limits -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { SubscriptionModel } from '../models/Subscription';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { PLAN_SEEDS } from '../seed/plans.seed';

/** The authoritative values, keyed by the code family (monthly and annual share them). */
const byFamily = new Map(
  PLAN_SEEDS.map((plan) => [plan.code.replace('-monthly', ''), { limits: plan.limits, features: plan.features }]),
);

const family = (code: string) => code.replace(/-(monthly|annual)$/, '');

const NEW_LIMIT_KEYS = ['maxMonthlySales', 'maxCustomers', 'maxStorageBytes'] as const;
const NEW_FEATURE_KEYS = ['smsMarketing', 'emailMarketing', 'imageOptimization'] as const;

export async function backfillPlanLimits(): Promise<{ plans: number; subscriptions: number; skipped: string[] }> {
  const skipped: string[] = [];
  let plansUpdated = 0;
  let subscriptionsUpdated = 0;

  // ---- 1. the plan catalogue ------------------------------------------------
  const plans = await SubscriptionPlanModel.find().lean();
  for (const plan of plans) {
    const source = byFamily.get(family(plan.code));
    if (!source) {
      // A plan the platform admin created by hand. We have no defaults for it,
      // and guessing a limit for someone else's plan would be worse than
      // leaving the schema defaults (-1, unlimited) in place.
      skipped.push(plan.code);
      continue;
    }

    const patch: Record<string, unknown> = {};
    for (const key of NEW_LIMIT_KEYS) {
      if (plan.limits?.[key] === undefined) patch[`limits.${key}`] = source.limits[key];
    }
    for (const key of NEW_FEATURE_KEYS) {
      if (plan.features?.[key] === undefined) patch[`features.${key}`] = source.features[key];
    }

    if (Object.keys(patch).length > 0) {
      await SubscriptionPlanModel.updateOne({ _id: plan._id }, { $set: patch });
      plansUpdated += 1;
    }
  }

  // ---- 2. frozen snapshots on live subscriptions ---------------------------
  const subscriptions = await SubscriptionModel.find().select('planSnapshot').lean();
  for (const subscription of subscriptions) {
    const snapshot = subscription.planSnapshot;
    const source = byFamily.get(family(snapshot?.code ?? ''));
    if (!snapshot || !source) continue;

    const patch: Record<string, unknown> = {};
    for (const key of NEW_LIMIT_KEYS) {
      if (snapshot.limits?.[key] === undefined) patch[`planSnapshot.limits.${key}`] = source.limits[key];
    }
    for (const key of NEW_FEATURE_KEYS) {
      if (snapshot.features?.[key] === undefined) patch[`planSnapshot.features.${key}`] = source.features[key];
    }

    if (Object.keys(patch).length > 0) {
      await SubscriptionModel.updateOne({ _id: subscription._id }, { $set: patch });
      subscriptionsUpdated += 1;
    }
  }

  return { plans: plansUpdated, subscriptions: subscriptionsUpdated, skipped };
}

/** Standalone entry point. */
async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const result = await backfillPlanLimits();
  logger.info('Plan limit backfill complete', result);
  if (result.skipped.length > 0) {
    logger.warn('Custom plans left untouched - review their limits by hand', { codes: result.skipped });
  }
  await mongoose.disconnect();
}

// Only run when invoked directly, so the function stays importable from tests.
if (process.argv[1]?.includes('backfillPlanLimits')) {
  main().catch((error) => {
    logger.error('Plan limit backfill failed', { error: String(error) });
    process.exit(1);
  });
}
