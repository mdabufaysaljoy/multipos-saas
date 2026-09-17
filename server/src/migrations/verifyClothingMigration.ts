/**
 * READ-ONLY verification that the existing Clothing POS is fully connected to
 * the multi-POS platform. It writes NOTHING - no collection is created,
 * updated or deleted - so it is safe to run against production at any time.
 *
 * It answers, for every workspace and subscription already in the database:
 *
 *   1. Is each workspace linked to an account and marked with a POS type?
 *   2. Is the Clothing POS product present and active in the platform catalog?
 *   3. Does every subscription resolve to a catalog tier - Starter,
 *      Professional or Enterprise - including the legacy `showroom-*` and
 *      `brand-*` codes, WITHOUT those stored codes being renamed?
 *   4. Does every subscription carry its workspace fields (accountId,
 *      posProductCode, billingCycle, price) and exactly one primary?
 *   5. Do the historical plan snapshots still hold their original prices?
 *
 * Anything it reports as missing is fixed by the existing backfill chain
 * (`npm run migrate` from the repo root), never by this script.
 *
 * Run with:  npm run migrate:verify-clothing -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { DEFAULT_POS_VERTICAL } from '../config/verticals';
import { CatalogPlanModel } from '../models/CatalogPlan';
import { PosProductModel } from '../models/PosProduct';
import { SubscriptionModel } from '../models/Subscription';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { TenantModel } from '../models/Tenant';

export interface ClothingMigrationReport {
  workspaces: { total: number; clothing: number; withoutAccount: number; withoutVertical: number };
  posProduct: { present: boolean; status: string | null };
  subscriptions: {
    total: number;
    mapped: number;
    unmapped: { planCode: string; count: number }[];
    missingWorkspaceFields: number;
    workspacesWithoutPrimary: number;
    workspacesWithSeveralPrimaries: number;
  };
  planMapping: { planCode: string; planName: string; catalogPlan: string | null; tierName: string | null }[];
  historicalPrices: { snapshotsWithPrice: number; snapshotsWithoutPrice: number };
  ready: boolean;
}

export async function verifyClothingMigration(): Promise<ClothingMigrationReport> {
  // Raw reads, so a field missing in the database reads as missing rather than
  // as its schema default.
  const [total, clothing, withoutAccount, withoutVertical] = await Promise.all([
    TenantModel.collection.countDocuments({}),
    TenantModel.collection.countDocuments({ vertical: DEFAULT_POS_VERTICAL }),
    TenantModel.collection.countDocuments({ $or: [{ accountId: null }, { accountId: { $exists: false } }] }),
    TenantModel.collection.countDocuments({ $or: [{ vertical: null }, { vertical: { $exists: false } }, { vertical: '' }] }),
  ]);

  const posProduct = await PosProductModel.findOne({ code: DEFAULT_POS_VERTICAL }).select('status').lean();

  // The legacy code -> catalog tier mapping, read from the catalog itself.
  const catalogPlans = await CatalogPlanModel.find().select('code displayName metadata').lean();
  const tierOf = (planCode: string) => {
    const match = catalogPlans.find(
      (plan) => plan.metadata?.legacyPlanCodes?.monthly === planCode || plan.metadata?.legacyPlanCodes?.annual === planCode,
    );
    return match ? { catalogPlan: match.code, tierName: match.displayName } : { catalogPlan: null, tierName: null };
  };

  const sellablePlans = await SubscriptionPlanModel.find().select('code name').lean();
  const planMapping = sellablePlans
    .map((plan) => ({ planCode: plan.code, planName: plan.name, ...tierOf(plan.code) }))
    .sort((a, b) => a.planCode.localeCompare(b.planCode));

  const subscriptionsTotal = await SubscriptionModel.collection.countDocuments({});
  const byPlanCode = await SubscriptionModel.collection
    .aggregate<{ _id: string | null; count: number }>([{ $group: { _id: '$planSnapshot.code', count: { $sum: 1 } } }])
    .toArray();
  let mapped = 0;
  const unmapped: { planCode: string; count: number }[] = [];
  for (const row of byPlanCode) {
    if (row._id && tierOf(row._id).catalogPlan) mapped += row.count;
    else unmapped.push({ planCode: row._id ?? '(none)', count: row.count });
  }

  const missingWorkspaceFields = await SubscriptionModel.collection.countDocuments({
    $or: [
      { accountId: { $exists: false } },
      { posProductCode: { $exists: false } },
      { billingCycle: { $exists: false } },
      { priceMinor: { $exists: false } },
    ],
  });

  const primaries = await SubscriptionModel.collection
    .aggregate<{ _id: unknown; primaries: number }>([
      { $group: { _id: '$tenantId', primaries: { $sum: { $cond: [{ $eq: ['$isPrimary', true] }, 1, 0] } } } },
    ])
    .toArray();

  // Historical prices live in each subscription's frozen snapshot; they are
  // reported, never recalculated from today's catalog.
  const snapshotsWithPrice = await SubscriptionModel.collection.countDocuments({ 'planSnapshot.priceMinor': { $type: 'number' } });

  const report: ClothingMigrationReport = {
    workspaces: { total, clothing, withoutAccount, withoutVertical },
    posProduct: { present: Boolean(posProduct), status: posProduct?.status ?? null },
    subscriptions: {
      total: subscriptionsTotal,
      mapped,
      unmapped,
      missingWorkspaceFields,
      workspacesWithoutPrimary: primaries.filter((row) => row.primaries === 0).length,
      workspacesWithSeveralPrimaries: primaries.filter((row) => row.primaries > 1).length,
    },
    planMapping,
    historicalPrices: { snapshotsWithPrice, snapshotsWithoutPrice: subscriptionsTotal - snapshotsWithPrice },
    ready: false,
  };
  report.ready =
    withoutAccount === 0 &&
    withoutVertical === 0 &&
    posProduct?.status === 'active' &&
    unmapped.length === 0 &&
    missingWorkspaceFields === 0 &&
    report.subscriptions.workspacesWithoutPrimary === 0 &&
    report.subscriptions.workspacesWithSeveralPrimaries === 0;

  return report;
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  try {
    const report = await verifyClothingMigration();
    logger.info('Clothing POS migration status', report as unknown as Record<string, unknown>);
    for (const row of report.planMapping) {
      logger.info(`  ${row.planCode} (${row.planName}) -> ${row.tierName ?? 'UNMAPPED'}`);
    }
    logger.info(report.ready ? 'READY: the Clothing POS is fully connected to the platform.' : 'NOT READY: run `npm run migrate` from the repo root to fill what is missing.');
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1]?.includes('verifyClothingMigration')) {
  main().catch((error) => {
    logger.error('Verification failed', { error });
    process.exit(1);
  });
}
