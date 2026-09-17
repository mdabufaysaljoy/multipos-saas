/**
 * Issues receipts for wallet top-ups approved before receipts existed.
 *
 *   - Every approved, credited top-up gets exactly one receipt, dated when it
 *     was approved and numbered per year. Amounts come from the top-up itself.
 *   - Approvals interrupted between approval and credit are repaired: linked
 *     to their ledger credit if the money moved, back to pending if it did not.
 *   - Nothing else changes.
 *
 * Idempotent. Run with:  npm run migrate:receipts -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { DocumentSequenceModel } from '../models/DocumentSequence';
import { TopUpRequestModel } from '../models/TopUpRequest';
import { WalletReceiptModel } from '../models/WalletReceipt';
import { issueMissingReceipts } from '../services/billing/receipt.service';

export async function backfillReceipts(batch = 500) {
  const totals = { issued: 0, checked: 0, relinked: 0, reverted: 0 };
  for (;;) {
    const result = await issueMissingReceipts(batch);
    totals.issued += result.issued;
    totals.checked += result.checked;
    totals.relinked += result.relinked;
    totals.reverted += result.reverted;
    if (result.checked < batch || result.issued === 0) break;
  }
  return totals;
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  await Promise.all([WalletReceiptModel.syncIndexes(), DocumentSequenceModel.syncIndexes(), TopUpRequestModel.syncIndexes()]);
  logger.info('Receipt backfill complete', await backfillReceipts());
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('backfillReceipts')) {
  main().catch((error) => {
    logger.error('Receipt backfill failed', { error: String(error) });
    process.exit(1);
  });
}
