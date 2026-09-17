/**
 * Gives every existing ledger row its position in its wallet's chain.
 *
 * New rows get a `sequence` from the same atomic update that moves the balance.
 * Rows written before that field existed are ordered here, ONCE, by following
 * the balances they already carry: within each timestamp, the row whose
 * `balanceBeforeMinor` continues the previous row's `balanceAfterMinor` comes
 * next. That is what fixes movements written in the same millisecond being
 * listed out of order.
 *
 * Only `sequence` is written, and only where it is missing. No amount, balance,
 * date, reference or reason is ever touched - it runs as explicit ledger
 * maintenance, the only sanctioned change to historical rows. Each wallet's
 * counter is then set past its highest row, so the next movement continues the
 * chain. Idempotent: a second run changes nothing.
 *
 * Run with:  npm run migrate:wallet-sequences -w server
 */
import mongoose, { type Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { withLedgerMaintenance } from '../utils/ledgerMaintenance';
import { WalletModel } from '../models/Wallet';
import { WalletTransactionModel } from '../models/WalletTransaction';

interface Row {
  _id: Types.ObjectId;
  createdAt: Date;
  balanceBeforeMinor: number;
  balanceAfterMinor: number;
}

/**
 * Rows in the order the money actually moved: by time, and within the same
 * instant by whichever row continues the running balance. A row that continues
 * nothing keeps its existing relative position rather than being guessed at.
 */
export function chainOrder(rows: Row[]): Row[] {
  const byTime = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || String(a._id).localeCompare(String(b._id)));
  const ordered: Row[] = [];
  let index = 0;
  let running: number | null = null;

  while (index < byTime.length) {
    const instant = byTime[index].createdAt.getTime();
    const group: Row[] = [];
    while (index < byTime.length && byTime[index].createdAt.getTime() === instant) {
      group.push(byTime[index]);
      index += 1;
    }

    const remaining = [...group];
    while (remaining.length > 0) {
      const continues: number = running === null ? -1 : remaining.findIndex((row) => row.balanceBeforeMinor === running);
      const picked: Row = remaining.splice(continues >= 0 ? continues : 0, 1)[0];
      ordered.push(picked);
      running = picked.balanceAfterMinor;
    }
  }
  return ordered;
}

export async function backfillWalletSequences(): Promise<{ walletsProcessed: number; rowsSequenced: number }> {
  const wallets = await WalletModel.find().select('_id ledgerSequence').lean();
  let rowsSequenced = 0;
  let walletsProcessed = 0;

  for (const wallet of wallets) {
    const rows = await WalletTransactionModel.find({ walletId: wallet._id })
      .select('_id createdAt balanceBeforeMinor balanceAfterMinor sequence')
      .lean<(Row & { sequence: number | null })[]>();
    if (rows.length === 0) continue;
    walletsProcessed += 1;

    const ordered = chainOrder(rows);
    const writes = ordered
      .map((row, position) => ({ row, sequence: position + 1 }))
      .filter(({ row, sequence }) => (rows.find((candidate) => candidate._id.equals(row._id))?.sequence ?? null) !== sequence)
      .map(({ row, sequence }) => ({
        updateOne: { filter: { _id: row._id }, update: { $set: { sequence } }, timestamps: false },
      }));

    if (writes.length > 0) {
      await withLedgerMaintenance('backfill ledger sequence', async () => {
        await WalletTransactionModel.bulkWrite(writes, { ordered: true });
      });
      rowsSequenced += writes.length;
    }
    // The counter continues past the last row, so live movements keep the chain.
    if ((wallet.ledgerSequence ?? 0) < ordered.length) {
      await WalletModel.updateOne({ _id: wallet._id }, { $set: { ledgerSequence: ordered.length } }, { timestamps: false });
    }
  }

  await WalletTransactionModel.syncIndexes();
  return { walletsProcessed, rowsSequenced };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  try {
    logger.info('Wallet ledger sequences', await backfillWalletSequences());
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1]?.includes('backfillWalletSequences')) {
  main().catch((error) => {
    logger.error('Sequence backfill failed', { error });
    process.exit(1);
  });
}
