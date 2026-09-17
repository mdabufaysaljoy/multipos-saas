/**
 * Phase 1 of the multi-POS account layer: links every EXISTING workspace to a
 * platform account and marks it as a Clothing POS workspace.
 *
 *   - One account per owning user (`tenant.ownerUserId`). An owner with several
 *     workspaces gets ONE account that owns all of them.
 *   - `accountId` is only set where it is missing; an existing link is never
 *     changed.
 *   - `vertical` is only set where it is missing, to `clothing`.
 *
 * Nothing else is written: no tenant field other than those two, and no user,
 * store, product, sale, subscription, payment or wallet record is touched.
 *
 * Workspaces with no stored owner are reported and left unlinked rather than
 * guessed at. Idempotent: a second run changes nothing.
 *
 * Run with:  npm run migrate:accounts -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { DEFAULT_POS_VERTICAL } from '../config/verticals';
import { AccountModel } from '../models/Account';
import { TenantModel } from '../models/Tenant';
import { ensureAccountForOwner } from '../services/account/account.service';

export interface AccountBackfillResult {
  accountsCreated: number;
  tenantsLinked: number;
  verticalsSet: number;
  accountsProfiled: number;
  skippedWithoutOwner: string[];
}

export async function backfillAccounts(): Promise<AccountBackfillResult> {
  const accountsBefore = await AccountModel.countDocuments();

  // Raw read (lean), so a field missing in the database reads as missing
  // rather than as the schema default.
  const tenants = await TenantModel.find({
    $or: [{ accountId: null }, { vertical: { $exists: false } }],
  })
    .select('_id name ownerUserId contactEmail accountId vertical')
    .sort({ createdAt: 1 })
    .lean();

  let tenantsLinked = 0;
  let verticalsSet = 0;
  const skippedWithoutOwner: string[] = [];

  for (const tenant of tenants) {
    const set: Record<string, unknown> = {};

    if (!tenant.accountId) {
      if (tenant.ownerUserId) {
        set.accountId = await ensureAccountForOwner(tenant.ownerUserId, {
          name: tenant.name,
          contactEmail: tenant.contactEmail,
        });
      } else {
        skippedWithoutOwner.push(String(tenant._id));
      }
    }
    if (!tenant.vertical) set.vertical = DEFAULT_POS_VERTICAL;
    if (Object.keys(set).length === 0) continue;

    // Guarded so a link written concurrently is never overwritten.
    const guard = set.accountId ? { accountId: null } : {};
    const result = await TenantModel.updateOne({ _id: tenant._id, ...guard }, { $set: set });
    if (result.modifiedCount === 0) continue;
    if (set.accountId) tenantsLinked += 1;
    if (set.vertical) verticalsSet += 1;
  }

  // Accounts from before the contact fields: copy phone and country from the
  // account's first workspace. Only a MISSING field is written, never an edit.
  const bareAccounts = await AccountModel.find({
    $or: [{ contactPhone: { $exists: false } }, { country: { $exists: false } }],
  })
    .select('_id contactPhone country')
    .lean();
  let accountsProfiled = 0;
  for (const account of bareAccounts) {
    const first = await TenantModel.findOne({ accountId: account._id }).sort({ createdAt: 1 }).select('contactPhone country').lean();
    const set: Record<string, unknown> = {};
    if (account.contactPhone === undefined) set.contactPhone = first?.contactPhone ?? '';
    if (account.country === undefined) set.country = (first?.country || 'BD').toUpperCase();
    const result = await AccountModel.updateOne({ _id: account._id }, { $set: set }, { timestamps: false });
    if (result.modifiedCount > 0) accountsProfiled += 1;
  }

  return {
    accountsCreated: (await AccountModel.countDocuments()) - accountsBefore,
    tenantsLinked,
    verticalsSet,
    accountsProfiled,
    skippedWithoutOwner,
  };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  // The unique owner index must exist before any upsert relies on it.
  await AccountModel.syncIndexes();
  await TenantModel.syncIndexes();
  const result = await backfillAccounts();
  logger.info('Account backfill complete', result);
  if (result.skippedWithoutOwner.length > 0) {
    logger.warn('Workspaces without an owner were left unlinked', { tenants: result.skippedWithoutOwner });
  }
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('backfillAccounts')) {
  main().catch((error) => {
    logger.error('Account backfill failed', { error: String(error) });
    process.exit(1);
  });
}
