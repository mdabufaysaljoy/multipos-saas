import { z } from 'zod';
import { assertOrderedRange, calendarDate, objectId, paginationSchema } from '../common/common.validators';

const INVOICE_STATUSES = ['paid', 'partially_refunded', 'refunded'] as const;
const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'cancelled', 'refunded'] as const;

const invoiceFilters = paginationSchema.extend({
  status: z.enum(INVOICE_STATUSES).optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});

/** Strict: an unknown query key is a 422, not silently ignored. */
export const workspaceInvoiceQuerySchema = invoiceFilters.strict().superRefine(assertOrderedRange);

/** The workspace, when given, must be one the account owns - checked in the controller. */
export const accountInvoiceQuerySchema = invoiceFilters.extend({ workspaceId: objectId.optional() }).strict().superRefine(assertOrderedRange);

export const accountPaymentQuerySchema = paginationSchema
  .extend({ workspaceId: objectId.optional(), status: z.enum(PAYMENT_STATUSES).optional() })
  .strict();

export const invoiceParams = z.object({ invoiceId: objectId });

export type WorkspaceInvoiceQuery = z.infer<typeof workspaceInvoiceQuerySchema>;
export type AccountInvoiceQuery = z.infer<typeof accountInvoiceQuerySchema>;
export type AccountPaymentQuery = z.infer<typeof accountPaymentQuerySchema>;
export type InvoiceParams = z.infer<typeof invoiceParams>;

/** The longest period one statement covers. */
export const STATEMENT_MAX_DAYS = 366;

export const accountStatementQuerySchema = z
  .object({ from: calendarDate.optional(), to: calendarDate.optional(), workspaceId: objectId.optional() })
  .strict()
  .superRefine(assertOrderedRange)
  .superRefine((value, ctx) => {
    if (value.from && value.to && value.to.getTime() - value.from.getTime() > STATEMENT_MAX_DAYS * 86_400_000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: `A statement covers at most ${STATEMENT_MAX_DAYS} days` });
    }
  });

export const accountReceiptQuerySchema = paginationSchema
  .extend({ workspaceId: objectId.optional(), from: calendarDate.optional(), to: calendarDate.optional() })
  .strict()
  .superRefine(assertOrderedRange);

export const receiptParams = z.object({ receiptId: objectId });

export type AccountStatementQuery = z.infer<typeof accountStatementQuerySchema>;
export type AccountReceiptQuery = z.infer<typeof accountReceiptQuerySchema>;
export type ReceiptParams = z.infer<typeof receiptParams>;
