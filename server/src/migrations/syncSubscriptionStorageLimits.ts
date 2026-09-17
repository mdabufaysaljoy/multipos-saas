/**
 * Brings the storage limit on EXISTING subscriptions in line with the current
 * plan configuration.
 *
 * `planSnapshot` is deliberately frozen at purchase so a price or feature
 * change never rewrites a period a customer already paid for. Storage is the
 * one limit we do want applied retroactively, so this updates that single field
 * and nothing else.
 *
 * Preserved exactly: plan, status, start date, period dates, trial dates,
 * billing/payment references, autoRenew, cancellation state, and every other
 * limit and feature in the snapshot.
 *
 * Source of truth is the live `subscriptionplans` collection - not a constant
 * in this file - so a limit a platform admin edited is what gets applied.
 *
 * Subscriptions whose plan code no longer exists (a bespoke plan, or one
 * deleted since) are reported and left untouched: guessing a limit for a plan
 * we cannot read would be worse than leaving it alone.
 *
 * Idempotent: a subscription already on the right number is not written.
 *
 * Run with:  npm run migrate:subscription-storage -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { SubscriptionModel } from '../models/Subscription';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { DEFAULT_POS_VERTICAL } from '../config/verticals';
import { isPosVertical, resolvePlanForVertical } from '../services/subscription/planEntitlements';

export interface StorageSyncResult {
  updated: number;
  alreadyCorrect: number;
  skippedUnknownPlan: { code: string; count: number }[];
  byPlan: { code: string; bytes: number; updated: number }[];
}

export async function syncSubscriptionStorageLimits(): Promise<StorageSyncResult> {
  // Current plans, keyed by code. The limit is resolved per subscription below,
  // for the vertical that subscription was sold to.
  const plans = await SubscriptionPlanModel.find().select('code limits verticalOverrides').lean();
  const planByCode = new Map(plans.map((plan) => [plan.code, plan]));

  const subscriptions = await SubscriptionModel.find()
    .select('planSnapshot.code planSnapshot.vertical planSnapshot.limits.maxStorageBytes')
    .lean();

  let updated = 0;
  let alreadyCorrect = 0;
  const skipped = new Map<string, number>();
  const perPlan = new Map<string, { bytes: number; updated: number }>();

  for (const subscription of subscriptions) {
    const code = subscription.planSnapshot?.code;
    if (!code) continue;

    const plan = planByCode.get(code);
    const vertical = isPosVertical(subscription.planSnapshot?.vertical) ? subscription.planSnapshot.vertical : DEFAULT_POS_VERTICAL;
    const target = plan ? resolvePlanForVertical(plan, vertical).limits.maxStorageBytes : undefined;
    if (target === undefined) {
      skipped.set(code, (skipped.get(code) ?? 0) + 1);
      continue;
    }

    if (subscription.planSnapshot?.limits?.maxStorageBytes === target) {
      alreadyCorrect += 1;
      continue;
    }

    // A dot-path update so only this one field is written. Assigning the whole
    // `limits` object would replace every other limit in the snapshot.
    await SubscriptionModel.updateOne(
      { _id: subscription._id },
      { $set: { 'planSnapshot.limits.maxStorageBytes': target } },
    );

    updated += 1;
    const entry = perPlan.get(code) ?? { bytes: target, updated: 0 };
    entry.updated += 1;
    perPlan.set(code, entry);
  }

  return {
    updated,
    alreadyCorrect,
    skippedUnknownPlan: [...skipped].map(([code, count]) => ({ code, count })),
    byPlan: [...perPlan].map(([code, v]) => ({ code, bytes: v.bytes, updated: v.updated })),
  };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const result = await syncSubscriptionStorageLimits();
  logger.info('Subscription storage limits synced', {
    updated: result.updated,
    alreadyCorrect: result.alreadyCorrect,
    byPlan: result.byPlan,
  });
  if (result.skippedUnknownPlan.length > 0) {
    logger.warn('Subscriptions on a plan that no longer exists were left untouched', {
      plans: result.skippedUnknownPlan,
    });
  }
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('syncSubscriptionStorageLimits')) {
  main().catch((error) => {
    logger.error('Subscription storage sync failed', { error: String(error) });
    process.exit(1);
  });
}
