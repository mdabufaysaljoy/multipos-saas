/**
 * Grants the new `sales.sellOutOfStock` permission to the built-in
 * "Senior Cashier" and "Store Manager" roles of EXISTING tenants. Tenants
 * created from now on get it from `roles.defaults.ts`. Tenant admins hold every
 * permission already; plain Cashiers and custom roles are left alone.
 *
 * Idempotent and revocation-safe: each role is marked in
 * `appliedPermissionDefaults`, so a re-run never re-grants the permission to a
 * role whose admin has since removed it.
 *
 * Run with:  npm run migrate:out-of-stock-permission -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { PERMISSIONS } from '../config/permissions';
import { RoleModel } from '../models/Role';
import { logger } from '../utils/logger';

const KEY = PERMISSIONS.SALES_SELL_OUT_OF_STOCK;
const ROLE_NAMES = ['Senior Cashier', 'Store Manager'];

export async function grantOutOfStockPermission(): Promise<{ rolesUpdated: number }> {
  const result = await RoleModel.updateMany(
    { isSystem: true, name: { $in: ROLE_NAMES }, appliedPermissionDefaults: { $ne: KEY } },
    { $addToSet: { permissions: KEY, appliedPermissionDefaults: KEY } },
  );
  return { rolesUpdated: result.modifiedCount };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const result = await grantOutOfStockPermission();
  logger.info('Out-of-stock sale permission granted to built-in roles', result);
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('grantOutOfStockPermission')) {
  main().catch((error) => {
    logger.error('Out-of-stock permission migration failed', { error: String(error) });
    process.exit(1);
  });
}
