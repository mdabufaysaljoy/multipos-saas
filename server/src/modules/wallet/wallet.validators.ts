import { z } from 'zod';
import { PAYMENT_PROVIDERS } from '../../config/constants';
import { paginationSchema, calendarDate, objectId, phoneNumber } from '../common/common.validators';
import { TOPUP_STATUSES } from '../../models/TopUpRequest';
import { WALLET_TX_TYPES } from '../../models/WalletTransaction';
import { USAGE_SERVICES } from '../../models/UsageCharge';

export const topUpRequestSchema = z.object({
  amountMinor: z.number().int().min(1, 'Enter the amount you sent'),
  paymentMethod: z.enum([PAYMENT_PROVIDERS.BKASH, PAYMENT_PROVIDERS.NAGAD, PAYMENT_PROVIDERS.BANK]),
  // Both are required: without the sending number a platform admin cannot
  // match the payment to a real transfer, which is the whole point of the
  // manual verification step.
  senderNumber: phoneNumber,
  transactionId: z.string().trim().min(4, 'Enter the transaction ID').max(64),
  note: z.string().trim().max(500).optional().default(''),
});

export const walletHistorySchema = paginationSchema.extend({
  type: z.enum(WALLET_TX_TYPES).optional(),
  service: z.enum(['topup', 'subscription', 'sms', 'email', 'ai', 'storage', 'refund', 'adjustment']).optional(),
  direction: z.enum(['credit', 'debit']).optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  sortBy: z.enum(['newest', 'oldest', 'highest', 'lowest']).default('newest'),
});

export const walletBreakdownSchema = z.object({
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});

/** Platform admin manually moving money, e.g. a goodwill credit. */
export const manualAdjustmentSchema = z.object({
  direction: z.enum(['credit', 'debit']),
  amountMinor: z.number().int().min(1),
  reason: z.string().trim().min(3, 'A reason is required for a manual adjustment').max(300),
});

export const reviewTopUpSchema = z.object({
  reviewNote: z.string().trim().max(500).optional().default(''),
});

/** Usage charges for the paid platform services. */
export const usageListSchema = paginationSchema.extend({
  service: z.enum(USAGE_SERVICES).optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});

export type TopUpRequestInput = z.infer<typeof topUpRequestSchema>;
export type UsageListInput = z.infer<typeof usageListSchema>;
export type WalletHistoryInput = z.infer<typeof walletHistorySchema>;
export type ManualAdjustmentInput = z.infer<typeof manualAdjustmentSchema>;

/**
 * A top-up requested by the account owner from Billing. Strict: the account is
 * the session's, and the workspace, when named, must be one it owns - checked
 * in the controller. Without one it is filed against the account's first workspace.
 */
export const accountTopUpSchema = topUpRequestSchema.extend({ workspaceId: objectId.optional() }).strict();

export const accountTopUpListSchema = paginationSchema
  .extend({ workspaceId: objectId.optional(), status: z.enum(TOPUP_STATUSES).optional() })
  .strict();

export const topUpParams = z.object({ topUpId: objectId });

export type AccountTopUpInput = z.infer<typeof accountTopUpSchema>;
export type AccountTopUpListInput = z.infer<typeof accountTopUpListSchema>;

/** The account wallet's transactions, optionally for one of the account's workspaces (checked against ownership). */
export const accountWalletTransactionsSchema = walletHistorySchema.extend({ workspaceId: objectId.optional() }).strict();
export type AccountWalletTransactionsInput = z.infer<typeof accountWalletTransactionsSchema>;
export const accountWalletSummarySchema = walletBreakdownSchema.strict();

/**
 * Opening a payment the customer settles by sending money to a platform
 * merchant wallet. There is deliberately no status, no balance and no account
 * field: the amount is what they owe, and proof comes from the SMS later.
 */
export const sendMoneyPaymentSchema = z
  .object({
    amountMinor: z.number().int().min(1, 'Enter the amount you are sending').max(10_000_000),
    provider: z.enum([PAYMENT_PROVIDERS.BKASH, PAYMENT_PROVIDERS.NAGAD]),
    reference: z.string().trim().min(4, 'Enter the transaction ID').max(64),
    customerPhone: phoneNumber,
    workspaceId: objectId.optional(),
  })
  .strict();
export type SendMoneyPaymentInput = z.infer<typeof sendMoneyPaymentSchema>;

/** Opening a payment on a provider's hosted page. */
export const hostedPaymentSchema = z
  .object({
    amountMinor: z.number().int().min(1).max(10_000_000),
    provider: z.enum([PAYMENT_PROVIDERS.UDDOKTAPAY]),
    workspaceId: objectId.optional(),
  })
  .strict();
export type HostedPaymentInput = z.infer<typeof hostedPaymentSchema>;
