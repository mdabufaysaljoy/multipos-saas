/**
 * Bulk product import rollout for EXISTING data (new data gets it from the seed
 * and `roles.defaults.ts`). Idempotent; safe to run repeatedly.
 *
 *   1. Plans: sets `features.productImport: true` where it is MISSING. Import is
 *      part of EVERY plan - Starter included - so there is no plan family to
 *      look up and no plan that should be skipped.
 *   2. Subscriptions: a `planSnapshot` frozen before the flag existed has no
 *      value for it. The entitlement layer already reads a missing
 *      `productImport` as ON (see entitlement.service.ts), so nobody is locked
 *      out before this runs; the backfill just makes the stored data say what
 *      the plan means, which is also what the pricing page reads.
 *   3. Built-in roles: grants `products.import` to Store Manager, once per role
 *      (marked in `appliedPermissionDefaults`), so a permission an admin removes
 *      is never re-granted. Tenant admins already hold every permission.
 *
 * Nothing is deleted and nothing is imported.
 *
 * Run with:  npm run migrate:product-import -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { PERMISSIONS } from '../config/permissions';
import { RoleModel } from '../models/Role';
import { SubscriptionModel } from '../models/Subscription';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { logger } from '../utils/logger';

const KEY = PERMISSIONS.PRODUCTS_IMPORT;
const ROLE_NAMES = ['Store Manager'];

export async function enableProductImport() {
  const plans = await SubscriptionPlanModel.updateMany(
    { 'features.productImport': { $exists: false } },
    { $set: { 'features.productImport': true } },
  );

  const subscriptions = await SubscriptionModel.updateMany(
    { planSnapshot: { $exists: true }, 'planSnapshot.features.productImport': { $exists: false } },
    { $set: { 'planSnapshot.features.productImport': true } },
  );

  const roles = await RoleModel.updateMany(
    { isSystem: true, name: { $in: ROLE_NAMES }, appliedPermissionDefaults: { $ne: KEY } },
    { $addToSet: { permissions: KEY, appliedPermissionDefaults: KEY } },
  );

  return { plans: plans.modifiedCount, subscriptions: subscriptions.modifiedCount, roleGrants: roles.modifiedCount };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const result = await enableProductImport();
  logger.info('Product import rollout complete', result);
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('enableProductImport')) {
  main().catch((error) => {
    logger.error('Product import rollout failed', { error: String(error) });
    process.exit(1);
  });
}
