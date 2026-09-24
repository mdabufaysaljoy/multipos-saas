/**
 * Supplier management rollout for EXISTING data (new data gets it from the seed
 * and `roles.defaults.ts`). Idempotent; safe to run repeatedly.
 *
 *   1. Plans: sets `features.supplierManagement` and `limits.maxSuppliers` where
 *      they are MISSING, from the plan family - Starter off / 0, Professional
 *      on / 100, Enterprise on / unlimited. Plans a platform admin created by
 *      hand are left alone and reported.
 *   2. Subscriptions: a `planSnapshot` frozen before the feature existed has no
 *      value for either key, which reads as "feature off" and (for the limit)
 *      "unlimited". Both are corrected from the plan family, so a paying
 *      Professional/Enterprise workspace gets what it pays for and a Starter
 *      one stays out.
 *   3. Built-in roles: grants the four `suppliers.*` permissions to Store
 *      Manager, once per role (marked in `appliedPermissionDefaults`), so a
 *      permission an admin removes is never re-granted. Tenant admins already
 *      hold every permission.
 *
 * No supplier record is created, changed or deleted.
 *
 * Run with:  npm run migrate:suppliers -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { PERMISSIONS } from '../config/permissions';
import { RoleModel } from '../models/Role';
import { SubscriptionModel } from '../models/Subscription';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { PLAN_SEEDS } from '../seed/plans.seed';
import { logger } from '../utils/logger';

const family = (code: string) => code.replace(/-(monthly|annual)$/, '');
const seedByFamily = new Map(
  PLAN_SEEDS.map((plan) => [family(plan.code), { feature: plan.features.supplierManagement, limit: plan.limits.maxSuppliers }]),
);

const ROLE_GRANTS = [
  PERMISSIONS.SUPPLIERS_VIEW,
  PERMISSIONS.SUPPLIERS_CREATE,
  PERMISSIONS.SUPPLIERS_EDIT,
  PERMISSIONS.SUPPLIERS_DELETE,
];
const ROLE_NAMES = ['Store Manager'];

export async function enableSupplierManagement() {
  const skipped: string[] = [];
  let plans = 0;
  let subscriptions = 0;
  let roles = 0;

  for (const plan of await SubscriptionPlanModel.find().select('code features limits').lean()) {
    const seed = seedByFamily.get(family(plan.code));
    if (!seed) {
      if (plan.features?.supplierManagement === undefined || plan.limits?.maxSuppliers === undefined) skipped.push(plan.code);
      continue;
    }
    const set: Record<string, unknown> = {};
    if (plan.features?.supplierManagement === undefined) set['features.supplierManagement'] = seed.feature;
    if (plan.limits?.maxSuppliers === undefined) set['limits.maxSuppliers'] = seed.limit;
    if (Object.keys(set).length === 0) continue;
    await SubscriptionPlanModel.updateOne({ _id: plan._id }, { $set: set });
    plans += 1;
  }

  for (const subscription of await SubscriptionModel.find({
    $or: [{ 'planSnapshot.features.supplierManagement': { $exists: false } }, { 'planSnapshot.limits.maxSuppliers': { $exists: false } }],
  })
    .select('planSnapshot.code planSnapshot.features.supplierManagement planSnapshot.limits.maxSuppliers')
    .lean()) {
    const seed = seedByFamily.get(family(subscription.planSnapshot?.code ?? ''));
    if (!seed) continue;
    const features = subscription.planSnapshot?.features as Record<string, unknown> | undefined;
    const limits = subscription.planSnapshot?.limits as Record<string, unknown> | undefined;
    const set: Record<string, unknown> = {};
    if (features?.supplierManagement === undefined) set['planSnapshot.features.supplierManagement'] = seed.feature;
    if (limits?.maxSuppliers === undefined) set['planSnapshot.limits.maxSuppliers'] = seed.limit;
    if (Object.keys(set).length === 0) continue;
    await SubscriptionModel.updateOne({ _id: subscription._id }, { $set: set });
    subscriptions += 1;
  }

  for (const permission of ROLE_GRANTS) {
    const result = await RoleModel.updateMany(
      { isSystem: true, name: { $in: ROLE_NAMES }, appliedPermissionDefaults: { $ne: permission } },
      { $addToSet: { permissions: permission, appliedPermissionDefaults: permission } },
    );
    roles += result.modifiedCount;
  }

  return { plans, subscriptions, roleGrants: roles, skippedPlans: skipped };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const result = await enableSupplierManagement();
  logger.info('Supplier management rollout complete', result);
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('enableSupplierManagement')) {
  main().catch((error) => {
    logger.error('Supplier management rollout failed', { error: String(error) });
    process.exit(1);
  });
}
