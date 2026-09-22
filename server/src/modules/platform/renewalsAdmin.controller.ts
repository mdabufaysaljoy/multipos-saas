import { issueMissingReceipts } from '../../services/billing/receipt.service';
import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/apiResponse';
import { recordAudit } from '../../services/audit/audit.service';
import { renewDueWalletSubscriptions } from '../../services/subscription/walletRenewal.service';
import { retryFailedEmails, sendExpiryReminders } from '../../services/email/transactionalEmail.service';
import { expireLapsedSubscriptions, processRenewals } from '../../jobs/subscription.job';
import { issueMissingInvoices } from '../../services/billing/invoice.service';

/**
 * Runs the renewal pass now instead of waiting for the hourly job: wallet
 * renewals, provider renewals, then expiry. Every step is idempotent, so running
 * it early or twice never charges a period twice. Platform admins only.
 */
export const runRenewals = asyncHandler(async (req: Request, res: Response) => {
  const reminders = await sendExpiryReminders();
  const wallet = await renewDueWalletSubscriptions();
  const renewedByProvider = await processRenewals();
  const expired = await expireLapsedSubscriptions();
  const invoices = await issueMissingInvoices();
  const receipts = await issueMissingReceipts();
  const emails = await retryFailedEmails();
  const result = { reminders, wallet, renewedByProvider, expired, invoices, receipts, emails };
  await recordAudit(req, { action: 'subscriptions.renewals_run', newValue: result });
  ok(res, result);
});
