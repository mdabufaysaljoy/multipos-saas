import { z } from 'zod';
import { assertOrderedRange, calendarDate, objectId, paginationSchema } from '../common/common.validators';
import { STATEMENT_MAX_DAYS } from '../subscriptions/invoices.validators';

/**
 * Why a platform admin is opening a customer's account (a ticket number, the
 * customer's question). Required on every read of the account's details and
 * stored with the audit entry.
 */
const reason = z.string().trim().min(5, 'Give a reason for opening this account, such as a ticket number').max(200);
const workspaceId = objectId.optional();

export const accountListQuerySchema = paginationSchema
  .extend({ search: z.string().trim().max(120).optional(), status: z.enum(['active', 'suspended']).optional() })
  .strict();

export const accountParams = z.object({ accountId: objectId });
export const accountDocumentParams = z.object({ accountId: objectId, documentId: objectId });

export const supportReasonQuerySchema = z.object({ reason }).strict();

export const supportStatementQuerySchema = z
  .object({ reason, workspaceId, from: calendarDate.optional(), to: calendarDate.optional() })
  .strict()
  .superRefine(assertOrderedRange)
  .superRefine((value, ctx) => {
    if (value.from && value.to && value.to.getTime() - value.from.getTime() > STATEMENT_MAX_DAYS * 86_400_000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: `A statement covers at most ${STATEMENT_MAX_DAYS} days` });
    }
  });

export const supportInvoiceQuerySchema = paginationSchema
  .extend({ reason, workspaceId, status: z.enum(['paid', 'partially_refunded', 'refunded']).optional(), from: calendarDate.optional(), to: calendarDate.optional() })
  .strict()
  .superRefine(assertOrderedRange);

export const supportReceiptQuerySchema = paginationSchema
  .extend({ reason, workspaceId, from: calendarDate.optional(), to: calendarDate.optional() })
  .strict()
  .superRefine(assertOrderedRange);

export const supportPaymentQuerySchema = paginationSchema
  .extend({ reason, workspaceId, status: z.enum(['pending', 'paid', 'failed', 'cancelled', 'refunded']).optional() })
  .strict();

export const supportTopUpQuerySchema = paginationSchema
  .extend({ reason, workspaceId, status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() })
  .strict();

/** Platform view of the account wallet ledger. */
export const supportWalletQuerySchema = paginationSchema
  .extend({ reason, workspaceId, type: z.enum(['credit', 'debit', 'refund', 'adjustment', 'transfer_in', 'transfer_out']).optional() })
  .strict();

const adjustmentReason = z.string().trim().min(10, 'Explain the adjustment in at least 10 characters').max(250);

/**
 * A manual balance adjustment. The reason is mandatory and recorded on the
 * ledger row and in the audit log; the key makes a retried request safe.
 */
export const walletAdjustmentSchema = z
  .object({
    direction: z.enum(['credit', 'debit']),
    amountMinor: z.number().int().min(1).max(100_000_000),
    reason: adjustmentReason,
    source: z.enum(['admin_adjustment', 'promotional_credit']).default('admin_adjustment'),
    idempotencyKey: z.string().trim().regex(/^[A-Za-z0-9:_-]{8,100}$/, 'Use 8-100 letters, digits, colons, dashes or underscores'),
  })
  .strict()
  .refine((value) => !(value.source === 'promotional_credit' && value.direction === 'debit'), { path: ['source'], message: 'Promotional credit can only add money' });

export const walletReversalSchema = z.object({ reason: adjustmentReason }).strict();

export const accountTransactionParams = z.object({ accountId: objectId, transactionId: objectId });

export type WalletAdjustmentInput = z.infer<typeof walletAdjustmentSchema>;
