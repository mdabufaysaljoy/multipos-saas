/**
 * READ-ONLY report of emails held by more than one live user record.
 *
 * Such identities predate platform-wide unique logins. They still sign in (the
 * person picks which one after entering their password), but each should be
 * reviewed: usually the extra record should become a workspace membership.
 * Nothing is merged or changed here - sales and audit history reference these
 * user ids, so any merge is a deliberate, per-person decision.
 *
 * Run with:  npm run report:identities -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { TenantModel } from '../models/Tenant';
import { findDuplicateIdentities } from '../services/auth/identity.service';

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const groups = await findDuplicateIdentities();
  const tenantIds = groups.flatMap((g) => g.users.map((u) => u.tenantId)).filter(Boolean);
  const tenants = await TenantModel.find({ _id: { $in: tenantIds } }).select('name').lean();
  const nameOf = (id: unknown) => tenants.find((t) => String(t._id) === String(id))?.name ?? (id ? 'Unknown workspace' : 'Platform');

  for (const group of groups) {
    logger.info('Duplicate identity', {
      email: group._id,
      records: group.users.map((u) => ({
        userId: String(u.id),
        workspace: nameOf(u.tenantId),
        role: u.role,
        active: u.isActive,
        lastLoginAt: u.lastLoginAt,
      })),
    });
  }
  logger.info('Duplicate identity report complete', {
    emails: groups.length,
    records: groups.reduce((sum, g) => sum + g.count, 0),
  });
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('reportDuplicateIdentities')) {
  main().catch((error) => {
    logger.error('Duplicate identity report failed', { error: String(error) });
    process.exit(1);
  });
}
