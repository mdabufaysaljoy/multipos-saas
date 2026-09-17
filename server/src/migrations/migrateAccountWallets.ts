import { withLedgerMaintenance } from '../utils/ledgerMaintenance';
/**
 * Phase 2 of the multi-POS account layer: ONE WALLET PER ACCOUNT.
 *
 * Requires Phase 1 (`migrate:accounts`) so workspaces carry an `accountId`.
 *
 *   1. Resumes any merge that was interrupted part-way (balance taken from the
 *      old wallet but not yet delivered).
 *   2. For every account: the account wallet is the existing linked wallet, or
 *      else the OLDEST legacy wallet among its workspaces, which is linked in
 *      place (same document, same balance, same history).
 *   3. Any other legacy wallet of that account is merged in through ledgered
 *      transfer_out / transfer_in rows. No balance is ever set directly.
 *   4. Existing ledger rows are tagged with the paying `accountId`. That is the
 *      only change made to historical ledger rows; amounts, balances, types and
 *      references are never modified.
 *
 * Wallets that cannot be merged safely (different currency) are reported and
 * left untouched. Workspaces not linked to an account keep their own wallet.
 *
 * Money conservation is verified: the total of every balance plus any pending
 * transfer must be identical before and after, or the migration fails loudly.
 *
 * Idempotent. Run with:  npm run migrate:wallets -w server
 */
import mongoose, { type Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { TenantModel } from '../models/Tenant';
import { WalletModel } from '../models/Wallet';
import { WalletTransactionModel } from '../models/WalletTransaction';
import { walletService } from '../services/wallet/wallet.service';

export interface WalletMigrationResult {
  resumedTransfers: number;
  walletsLinked: number;
  walletsMerged: number;
  movedMinor: number;
  ledgerRowsTagged: number;
  skipped: { walletId: string; reason: string }[];
  totalMoneyMinor: number;
}

export async function totalWalletMoney(): Promise<number> {
  const [row] = await WalletModel.aggregate<{ total: number }>([
    { $group: { _id: null, total: { $sum: { $add: ['$balanceMinor', { $ifNull: ['$pendingTransferMinor', 0] }] } } } },
  ]);
  return row?.total ?? 0;
}

export async function migrateAccountWallets(): Promise<WalletMigrationResult> {
  const moneyBefore = await totalWalletMoney();
  const skipped: WalletMigrationResult['skipped'] = [];

  // 1. Unfinished merges first, so no balance is stranded in a pending field.
  let resumedTransfers = 0;
  const pending = await WalletModel.find({ mergedIntoWalletId: { $ne: null }, pendingTransferMinor: { $gt: 0 } })
    .select('_id')
    .lean();
  for (const wallet of pending) {
    if ((await walletService.completeTransfer(wallet._id)) > 0) resumedTransfers += 1;
  }

  // 2 + 3. Accounts, each with its workspaces oldest first.
  const tenants = await TenantModel.find({ accountId: { $ne: null } })
    .select('_id accountId')
    .sort({ createdAt: 1 })
    .lean();
  const tenantsByAccount = new Map<string, { accountId: Types.ObjectId; tenantIds: Types.ObjectId[] }>();
  for (const tenant of tenants) {
    const key = String(tenant.accountId);
    const entry = tenantsByAccount.get(key) ?? { accountId: tenant.accountId!, tenantIds: [] };
    entry.tenantIds.push(tenant._id);
    tenantsByAccount.set(key, entry);
  }

  let walletsLinked = 0;
  let walletsMerged = 0;
  let movedMinor = 0;

  for (const { accountId, tenantIds } of tenantsByAccount.values()) {
    let primary: { _id: Types.ObjectId } | null = await WalletModel.findOne({ accountId }).select('_id').lean();
    const legacy = await WalletModel.find({ tenantId: { $in: tenantIds }, accountId: null, mergedIntoWalletId: null })
      .select('_id balanceMinor')
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    if (!primary) {
      const oldest = legacy.shift();
      if (!oldest) continue; // No wallet yet; one is opened on first use.
      const linked = await WalletModel.updateOne(
        { _id: oldest._id, accountId: null, mergedIntoWalletId: null },
        { $set: { accountId } },
      );
      if (linked.modifiedCount === 0) continue;
      walletsLinked += 1;
      primary = { _id: oldest._id };
    }

    for (const wallet of legacy) {
      try {
        movedMinor += await walletService.mergeWallet(wallet._id, primary._id);
        walletsMerged += 1;
      } catch (error) {
        skipped.push({ walletId: String(wallet._id), reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  // 4. Tag ledger rows with the paying account.
  let ledgerRowsTagged = 0;
  const accountWallets = await WalletModel.find({ accountId: { $ne: null } }).select('_id accountId').lean();
  for (const wallet of accountWallets) {
    const children = await WalletModel.find({ mergedIntoWalletId: wallet._id }).select('_id').lean();
    // `timestamps: false`: tagging must not bump `updatedAt` on historical rows.
    // The ledger row is otherwise left byte-for-byte as it was.
    // The only change ever made to existing rows: tagging the paying account. Explicit maintenance.
    const result = await withLedgerMaintenance('tag ledger rows with their account', () =>
      WalletTransactionModel.updateMany(
        { walletId: { $in: [wallet._id, ...children.map((c) => c._id)] }, accountId: null },
        { $set: { accountId: wallet.accountId } },
        { timestamps: false },
      ).exec(),
    );
    ledgerRowsTagged += result.modifiedCount;
  }

  const moneyAfter = await totalWalletMoney();
  if (moneyAfter !== moneyBefore) {
    throw new Error(`Wallet money is not conserved: ${moneyBefore} before, ${moneyAfter} after. Investigate before retrying.`);
  }

  return {
    resumedTransfers,
    walletsLinked,
    walletsMerged,
    movedMinor,
    ledgerRowsTagged,
    skipped,
    totalMoneyMinor: moneyAfter,
  };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  // Unique and partial indexes must exist before anything relies on them.
  await WalletModel.syncIndexes();
  await WalletTransactionModel.syncIndexes();
  const result = await migrateAccountWallets();
  logger.info('Account wallets migrated', result);
  if (result.skipped.length > 0) {
    logger.warn('Some wallets were left untouched and need manual review', { skipped: result.skipped });
  }
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('migrateAccountWallets')) {
  main().catch((error) => {
    logger.error('Account wallet migration failed', { error: String(error) });
    process.exit(1);
  });
}
