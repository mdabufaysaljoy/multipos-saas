/**
 * Applies the current package names and prices to an EXISTING database.
 *
 * Packages were renamed (Showroom -> Professional, Brand -> Enterprise,
 * Starter Store -> Starter) and repriced. Plan CODES did not change, so every
 * subscription, upgrade request and payment keeps pointing at the right plan.
 *
 *   1. Live plans (`subscriptionplans`): name, description and priceMinor are
 *      set from the seed definitions, matched by code. Limits, features, trial
 *      days, visibility and tier are NOT touched.
 *
 *   2. Existing subscriptions and upgrade requests: ONLY the display label
 *      `planSnapshot.name` is updated, so an old `showroom-monthly` subscription
 *      reads "Professional" everywhere it is shown. The price paid, status,
 *      billing cycle, period dates, limits, features and payment references in
 *      the snapshot are preserved exactly - a customer's history keeps the
 *      amount they actually paid.
 *
 * Payments and wallet transactions are not modified at all.
 *
 * Codes that are not in the seed catalogue (bespoke plans) are left alone.
 * Idempotent: rows already correct are not written.
 *
 * Run with:  npm run migrate:plan-packages -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { SubscriptionModel } from '../models/Subscription';
import { UpgradeRequestModel } from '../models/UpgradeRequest';
import { ALL_PLAN_SEEDS } from '../seed/plans.seed';

export interface PlanPackageSyncResult {
  plansUpdated: string[];
  plansMissing: string[];
  subscriptionsRelabelled: number;
  upgradeRequestsRelabelled: number;
}

export async function syncPlanPackages(): Promise<PlanPackageSyncResult> {
  const plansUpdated: string[] = [];
  const plansMissing: string[] = [];

  for (const seed of ALL_PLAN_SEEDS) {
    const plan = await SubscriptionPlanModel.findOne({ code: seed.code }).select('name description priceMinor').lean();
    if (!plan) {
      plansMissing.push(seed.code);
      continue;
    }
    if (plan.name === seed.name && plan.description === seed.description && plan.priceMinor === seed.priceMinor) continue;

    await SubscriptionPlanModel.updateOne(
      { code: seed.code },
      { $set: { name: seed.name, description: seed.description, priceMinor: seed.priceMinor } },
    );
    plansUpdated.push(seed.code);
  }

  // Dot-path updates, so nothing else in the snapshot is rewritten.
  let subscriptionsRelabelled = 0;
  let upgradeRequestsRelabelled = 0;
  for (const seed of ALL_PLAN_SEEDS) {
    const filter = { 'planSnapshot.code': seed.code, 'planSnapshot.name': { $ne: seed.name } };
    const update = { $set: { 'planSnapshot.name': seed.name } };
    subscriptionsRelabelled += (await SubscriptionModel.updateMany(filter, update)).modifiedCount;
    upgradeRequestsRelabelled += (await UpgradeRequestModel.updateMany(filter, update)).modifiedCount;
  }

  return { plansUpdated, plansMissing, subscriptionsRelabelled, upgradeRequestsRelabelled };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const result = await syncPlanPackages();
  logger.info('Plan packages synced', result);
  if (result.plansMissing.length > 0) {
    logger.warn('Some catalogue plans do not exist in this database; run the seed to create them', {
      plans: result.plansMissing,
    });
  }
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('syncPlanPackages')) {
  main().catch((error) => {
    logger.error('Plan package sync failed', { error: String(error) });
    process.exit(1);
  });
}
