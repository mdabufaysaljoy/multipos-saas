/**
 * Applies the universal product ceilings to every built-in plan and existing
 * subscription snapshot:
 *   Starter      3,000
 *   Professional 30,000
 *   Enterprise   unlimited (-1)
 *
 * Product limits used to have a Pharmacy-only override. Removing that field is
 * part of this migration so every current and future POS resolves the same
 * tier value from the base plan. Custom plans are deliberately left alone.
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { SubscriptionModel } from '../models/Subscription';
import { ALL_PLAN_SEEDS } from '../seed/plans.seed';
import { logger } from '../utils/logger';

export interface ProductLimitSyncResult {
  plansUpdated: string[];
  verticalOverridesRemoved: number;
  subscriptionSnapshotsUpdated: number;
}

export async function syncProductLimits(): Promise<ProductLimitSyncResult> {
  const plansUpdated: string[] = [];
  let subscriptionSnapshotsUpdated = 0;

  // Remove only product-limit overrides. Availability and every other
  // vertical-specific feature/limit remain untouched.
  const verticalOverridesRemoved = (
    await SubscriptionPlanModel.collection.updateMany(
      { 'verticalOverrides.limits.maxProducts': { $exists: true } },
      { $unset: { 'verticalOverrides.$[].limits.maxProducts': '' } },
    )
  ).modifiedCount;

  for (const seed of ALL_PLAN_SEEDS) {
    const maxProducts = seed.limits.maxProducts;
    const planUpdate = await SubscriptionPlanModel.updateOne(
      { code: seed.code, 'limits.maxProducts': { $ne: maxProducts } },
      { $set: { 'limits.maxProducts': maxProducts } },
    );
    if (planUpdate.modifiedCount > 0) plansUpdated.push(seed.code);

    subscriptionSnapshotsUpdated += (
      await SubscriptionModel.updateMany(
        { 'planSnapshot.code': seed.code, 'planSnapshot.limits.maxProducts': { $ne: maxProducts } },
        { $set: { 'planSnapshot.limits.maxProducts': maxProducts } },
      )
    ).modifiedCount;
  }

  return { plansUpdated, verticalOverridesRemoved, subscriptionSnapshotsUpdated };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  logger.info('Universal product limits synced', await syncProductLimits());
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('syncProductLimits')) {
  main().catch((error) => {
    logger.error('Universal product-limit migration failed', { error: String(error) });
    process.exit(1);
  });
}
