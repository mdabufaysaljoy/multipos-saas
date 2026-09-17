/**
 * Brings existing wallets and ledger rows up to the account-ledger schema.
 *
 *   - Wallets get `status` from `isFrozen`.
 *   - Ledger rows missing `currency`, `source` or `status` get them: currency
 *     from their wallet, source from their reference type (and top-up method),
 *     status `posted`. Amounts, balances, dates and references are untouched -
 *     this runs as explicit ledger maintenance, the only sanctioned change to
 *     historical rows.
 *   - The idempotency and one-reversal indexes are built.
 *
 * Idempotent. Run with:  npm run migrate:wallet-ledger -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { withLedgerMaintenance } from '../utils/ledgerMaintenance';
import { WalletModel } from '../models/Wallet';
import { WalletTransactionModel } from '../models/WalletTransaction';

const sourceExpression = {
  $switch: {
    branches: [
      { case: { $and: [{ $eq: ['$referenceType', 'topup'] }, { $in: ['$metadata.method', ['bkash', 'nagad', 'bank']] }] }, then: '$metadata.method' },
      { case: { $eq: ['$referenceType', 'topup'] }, then: 'manual_topup' },
      { case: { $in: ['$referenceType', ['subscription', 'sms', 'email', 'ai', 'storage', 'refund', 'transfer']] }, then: '$referenceType' },
      { case: { $eq: ['$referenceType', 'adjustment'] }, then: 'admin_adjustment' },
    ],
    default: 'system',
  },
};

export async function backfillWalletLedger() {
  const wallets = await WalletModel.updateMany({ status: { $exists: false } }, [{ $set: { status: { $cond: ['$isFrozen', 'frozen', 'active'] } } }]);

  const ledgerRowsBackfilled = await withLedgerMaintenance('backfill ledger descriptive fields', async () => {
    let updated = 0;
    const all = await WalletModel.find().select('_id currency').lean();
    for (const wallet of all) {
      const result = await WalletTransactionModel.updateMany(
        { walletId: wallet._id, $or: [{ currency: { $exists: false } }, { source: { $exists: false } }, { status: { $exists: false } }] },
        [
          {
            $set: {
              currency: { $ifNull: ['$currency', wallet.currency ?? 'BDT'] },
              status: { $ifNull: ['$status', 'posted'] },
              source: { $ifNull: ['$source', sourceExpression] },
            },
          },
        ],
        { timestamps: false },
      ).exec();
      updated += result.modifiedCount;
    }
    return updated;
  });

  return { walletsWithStatus: wallets.modifiedCount, ledgerRowsBackfilled };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const result = await backfillWalletLedger();
  await Promise.all([WalletModel.syncIndexes(), WalletTransactionModel.syncIndexes()]);
  logger.info('Wallet ledger backfill complete', result);
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('backfillWalletLedger')) {
  main().catch((error) => {
    logger.error('Wallet ledger backfill failed', { error: String(error) });
    process.exit(1);
  });
}
