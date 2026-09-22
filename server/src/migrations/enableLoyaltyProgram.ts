/**
 * Loyalty program rollout for EXISTING data (new data gets it from the seed and
 * `roles.defaults.ts`). Idempotent; safe to run repeatedly.
 *
 *   1. Plans: sets `features.loyaltyProgram` where it is MISSING, from the plan
 *      family (Starter off, Professional and Enterprise on). Plans a platform
 *      admin created by hand are left alone (missing = off) and reported.
 *   2. Subscriptions: a `planSnapshot` frozen before the flag existed (missing
 *      key), or taken from a plan document that had not been backfilled yet
 *      (key stored as false), would read as "off". Both are corrected from the
 *      plan family, so a paying Professional/Enterprise workspace gets the
 *      feature it pays for. A snapshot already set to true is left alone.
 *   3. Built-in roles: grants loyalty.redeem to Cashier, Senior Cashier and
 *      Store Manager, loyalty.view to Senior Cashier and Store Manager, and
 *      loyalty.manage to Store Manager - once per role (marked in
 *      `appliedPermissionDefaults`), so a permission an admin removes is never
 *      re-granted.
 *
 * Nothing is deleted and no store is switched on: the owner enables the
 * program in Settings -> Loyalty.
 *
 * Run with:  npm run migrate:loyalty -w server
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
const byFamily = new Map(PLAN_SEEDS.map((plan) => [family(plan.code), plan.features.loyaltyProgram]));

const ROLE_GRANTS: { role: string; permission: string }[] = [
  { role: 'Cashier', permission: PERMISSIONS.LOYALTY_REDEEM },
  { role: 'Senior Cashier', permission: PERMISSIONS.LOYALTY_REDEEM },
  { role: 'Senior Cashier', permission: PERMISSIONS.LOYALTY_VIEW },
  { role: 'Store Manager', permission: PERMISSIONS.LOYALTY_REDEEM },
  { role: 'Store Manager', permission: PERMISSIONS.LOYALTY_VIEW },
  { role: 'Store Manager', permission: PERMISSIONS.LOYALTY_MANAGE },
];

export async function enableLoyaltyProgram() {
  const skipped: string[] = [];
  let plans = 0;
  let subscriptions = 0;
  let roles = 0;

  for (const plan of await SubscriptionPlanModel.find().select('code features').lean()) {
    if (plan.features?.loyaltyProgram !== undefined) continue;
    const value = byFamily.get(family(plan.code));
    if (value === undefined) {
      skipped.push(plan.code);
      continue;
    }
    await SubscriptionPlanModel.updateOne({ _id: plan._id, 'features.loyaltyProgram': { $exists: false } }, { $set: { 'features.loyaltyProgram': value } });
    plans += 1;
  }

  // Missing, or stored as false on a plan that includes loyalty. The second case
  // is a snapshot taken from a plan document that had not been backfilled yet
  // (nobody can have chosen "off" for a feature that did not exist), so a paying
  // Professional/Enterprise workspace is not left without what it bought. A
  // snapshot already set to true is never touched.
  for (const subscription of await SubscriptionModel.find({ 'planSnapshot.features.loyaltyProgram': { $ne: true } }).select('planSnapshot.code planSnapshot.features.loyaltyProgram').lean()) {
    const value = byFamily.get(family(subscription.planSnapshot?.code ?? ''));
    const current = (subscription.planSnapshot?.features as Record<string, unknown> | undefined)?.loyaltyProgram;
    if (value === undefined || current === value) continue;
    await SubscriptionModel.updateOne(
      { _id: subscription._id, 'planSnapshot.features.loyaltyProgram': { $ne: true } },
      { $set: { 'planSnapshot.features.loyaltyProgram': value } },
    );
    subscriptions += 1;
  }

  for (const grant of ROLE_GRANTS) {
    const result = await RoleModel.updateMany(
      { isSystem: true, name: grant.role, appliedPermissionDefaults: { $ne: grant.permission } },
      { $addToSet: { permissions: grant.permission, appliedPermissionDefaults: grant.permission } },
    );
    roles += result.modifiedCount;
  }

  return { plans, subscriptions, roleGrants: roles, skippedPlans: skipped };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const result = await enableLoyaltyProgram();
  logger.info('Loyalty program rollout complete', result);
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('enableLoyaltyProgram')) {
  main().catch((error) => {
    logger.error('Loyalty program rollout failed', { error: String(error) });
    process.exit(1);
  });
}
