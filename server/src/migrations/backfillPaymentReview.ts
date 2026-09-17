/**
 * Moves review flags written before payment operations existed into the
 * `review` field the platform queue reads.
 *
 * Payments flagged with `metadata.reviewRequired` (overpaid, a "paid" report on
 * a non-pending payment, a missing plan) get `review.required = true` with that
 * reason and the payment's last update as the flag time. Nothing else is
 * written: the old metadata stays, no status or amount changes, `updatedAt` is
 * left alone. Idempotent: a second run changes nothing.
 *
 * Run with:  npm run migrate:payment-review -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { PaymentModel } from '../models/Payment';

export async function backfillPaymentReview(): Promise<{ flagged: number }> {
  const legacy = await PaymentModel.find({
    'metadata.reviewRequired': { $type: 'string' },
    'review.required': { $ne: true },
  })
    .select('_id metadata updatedAt')
    .lean();

  let flagged = 0;
  for (const payment of legacy) {
    const result = await PaymentModel.updateOne(
      { _id: payment._id, 'review.required': { $ne: true } },
      {
        $set: {
          'review.required': true,
          'review.reason': String((payment.metadata as Record<string, unknown>).reviewRequired),
          'review.flaggedAt': payment.updatedAt ?? new Date(),
          'review.resolvedAt': null,
          'review.resolvedBy': null,
          'review.resolvedByNameSnapshot': '',
          'review.resolutionNote': '',
        },
      },
      { timestamps: false },
    );
    flagged += result.modifiedCount;
  }
  return { flagged };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  await PaymentModel.syncIndexes();
  logger.info('Payment review backfill complete', await backfillPaymentReview());
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('backfillPaymentReview')) {
  main().catch((error) => {
    logger.error('Payment review backfill failed', { error: String(error) });
    process.exit(1);
  });
}
