/**
 * Expands only Pharmacy catalogue limits:
 *   Starter      300   -> 5,000
 *   Professional 3,000 -> 25,000
 *   Enterprise remains unlimited (-1)
 *
 * The shared plan limits are deliberately untouched, so Clothing, Restaurant
 * and Super Shop retain their existing ceilings. Existing Pharmacy
 * subscriptions receive this beneficial expansion immediately; no catalogue
 * data is removed or rewritten.
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { SubscriptionPlanModel, type VerticalOverride } from '../models/SubscriptionPlan';
import { SubscriptionModel } from '../models/Subscription';
import { TenantModel } from '../models/Tenant';
import { logger } from '../utils/logger';

const LIMIT_BY_CODE: Record<string, number> = {
  'starter-store-monthly': 5_000,
  'starter-store-annual': 5_000,
  'showroom-monthly': 25_000,
  'showroom-annual': 25_000,
  'brand-monthly': -1,
  'brand-annual': -1,
};

export interface PharmacyProductLimitMigrationResult {
  plansUpdated: string[];
  subscriptionSnapshotsUpdated: number;
}

export async function expandPharmacyProductLimits(): Promise<PharmacyProductLimitMigrationResult> {
  const plansUpdated: string[] = [];

  for (const [code, maxProducts] of Object.entries(LIMIT_BY_CODE)) {
    const plan = await SubscriptionPlanModel.findOne({ code }).select('verticalOverrides').lean();
    if (!plan) continue;

    const overrides = [...(plan.verticalOverrides ?? [])] as VerticalOverride[];
    const index = overrides.findIndex((entry) => entry.vertical === 'pharmacy');
    if (index >= 0) {
      const current = overrides[index];
      overrides[index] = { ...current, limits: { ...(current.limits ?? {}), maxProducts } };
    } else {
      overrides.push({ vertical: 'pharmacy', isAvailable: true, features: {}, limits: { maxProducts } });
    }

    await SubscriptionPlanModel.updateOne({ _id: plan._id }, { $set: { verticalOverrides: overrides } });
    plansUpdated.push(code);
  }

  const pharmacyTenantIds = await TenantModel.distinct('_id', { vertical: 'pharmacy' });
  let subscriptionSnapshotsUpdated = 0;
  for (const [code, maxProducts] of Object.entries(LIMIT_BY_CODE)) {
    subscriptionSnapshotsUpdated += (
      await SubscriptionModel.updateMany(
        { tenantId: { $in: pharmacyTenantIds }, 'planSnapshot.code': code, 'planSnapshot.limits.maxProducts': { $ne: maxProducts } },
        { $set: { 'planSnapshot.limits.maxProducts': maxProducts } },
      )
    ).modifiedCount;
  }

  return { plansUpdated, subscriptionSnapshotsUpdated };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  logger.info('Pharmacy product limits expanded', await expandPharmacyProductLimits());
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('expandPharmacyProductLimits')) {
  main().catch((error) => {
    logger.error('Pharmacy product-limit migration failed', { error: String(error) });
    process.exit(1);
  });
}
