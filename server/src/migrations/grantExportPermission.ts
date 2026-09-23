/**
 * Grants the new `reports.export` permission to the built-in "Store Manager"
 * role of EXISTING tenants. Tenants created from now on get it from
 * `roles.defaults.ts`. Tenant admins hold every permission already; other
 * built-in roles and custom roles are left alone.
 *
 * Idempotent and revocation-safe: the role is marked in
 * `appliedPermissionDefaults`, so a re-run never re-grants the permission to a
 * role whose admin has since removed it.
 *
 * Run with:  npm run migrate:export-permission -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { PERMISSIONS } from '../config/permissions';
import { RoleModel } from '../models/Role';
import { logger } from '../utils/logger';

const KEY = PERMISSIONS.REPORTS_EXPORT;
const ROLE_NAMES = ['Store Manager'];

export async function grantExportPermission(): Promise<{ rolesUpdated: number }> {
  const result = await RoleModel.updateMany(
    { isSystem: true, name: { $in: ROLE_NAMES }, appliedPermissionDefaults: { $ne: KEY } },
    { $addToSet: { permissions: KEY, appliedPermissionDefaults: KEY } },
  );
  return { rolesUpdated: result.modifiedCount };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const result = await grantExportPermission();
  logger.info('Data export permission granted to built-in roles', result);
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('grantExportPermission')) {
  main().catch((error) => {
    logger.error('Export permission migration failed', { error: String(error) });
    process.exit(1);
  });
}
