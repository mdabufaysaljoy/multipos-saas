/**
 * Issues invoices for subscription payments made before invoices existed.
 *
 *   - Every paid (or since refunded) payment that became a subscription period
 *     gets exactly one invoice, built from what the payment itself recorded -
 *     historical prices are copied, never recalculated from today's catalog.
 *   - Invoices are dated when the payment was made and numbered per year.
 *   - Nothing existing is changed except the payment's link to its invoice.
 *   - Payments that cannot be invoiced (no subscription period) are reported.
 *
 * Idempotent: a second run issues nothing. Run with:  npm run migrate:invoices -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { DocumentSequenceModel } from '../models/DocumentSequence';
import { InvoiceModel } from '../models/Invoice';
import { PaymentModel } from '../models/Payment';
import { issueMissingInvoices } from '../services/billing/invoice.service';

export async function backfillInvoices(batch = 500) {
  let issued = 0;
  let checked = 0;
  for (;;) {
    const result = await issueMissingInvoices(batch);
    issued += result.issued;
    checked += result.checked;
    // Stop when a pass issues nothing: what is left cannot be invoiced.
    if (result.checked < batch || result.issued === 0) break;
  }
  const uninvoiceable = await PaymentModel.countDocuments({ status: { $in: ['paid', 'refunded'] }, invoiceId: null });
  return { issued, checked, uninvoiceable };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  // The one-invoice-per-payment and unique-number guarantees must exist before issuing.
  await Promise.all([InvoiceModel.syncIndexes(), DocumentSequenceModel.syncIndexes()]);
  const result = await backfillInvoices();
  if (result.uninvoiceable > 0) logger.warn('Some paid payments have no subscription period and were not invoiced', { count: result.uninvoiceable });
  logger.info('Invoice backfill complete', result);
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('backfillInvoices')) {
  main().catch((error) => {
    logger.error('Invoice backfill failed', { error: String(error) });
    process.exit(1);
  });
}
