import { z } from 'zod';
import { PAYMENT_PROVIDERS, SUBSCRIPTION_STATUS } from '../../config/constants';
import { objectId, paginationSchema } from '../common/common.validators';

/** Platform admin manually assigning or changing a tenant's subscription. */
export const assignSubscriptionSchema = z
  .object({
    tenantId: objectId,
    planId: objectId,
    startDate: z.coerce.date().optional(),
    /** Either an explicit end date, or a number of billing periods. */
    endDate: z.coerce.date().optional(),
    periods: z.number().int().min(1).max(60).optional(),
    status: z.enum([SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIAL]).default(SUBSCRIPTION_STATUS.ACTIVE),
    autoRenew: z.boolean().default(false),
    notes: z.string().trim().max(500).optional().default(''),
    /** Optionally record the offline payment that paid for this. */
    recordPayment: z
      .object({
        amountMinor: z.number().int().min(0),
        provider: z.enum([PAYMENT_PROVIDERS.MANUAL, PAYMENT_PROVIDERS.BKASH, PAYMENT_PROVIDERS.NAGAD, PAYMENT_PROVIDERS.BANK]),
        reference: z.string().trim().max(120).optional().default(''),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.endDate && data.startDate && data.endDate <= data.startDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'The end date must be after the start date' });
    }
  });

export const extendSubscriptionSchema = z.object({
  /** Additional whole billing periods to append. */
  periods: z.number().int().min(1).max(60).optional(),
  /** Or push the end date to a specific day. */
  until: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional().default(''),
}).superRefine((data, ctx) => {
  if (!data.periods && !data.until) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periods'], message: 'Give either a number of periods or an end date' });
  }
});

export const setSubscriptionStatusSchema = z.object({
  status: z.enum([
    SUBSCRIPTION_STATUS.ACTIVE,
    SUBSCRIPTION_STATUS.SUSPENDED,
    SUBSCRIPTION_STATUS.EXPIRED,
    SUBSCRIPTION_STATUS.CANCELLED,
  ]),
  reason: z.string().trim().max(300).optional().default(''),
});

export const cancelSubscriptionSchema = z.object({
  /**
   * false (the default) lets the customer keep using the POS until the paid
   * period ends; true ends access immediately.
   */
  immediate: z.boolean().default(false),
  reason: z.string().trim().max(300).optional().default(''),
});

export const checkoutSchema = z.object({
  planId: objectId,
  provider: z.enum([PAYMENT_PROVIDERS.BKASH, PAYMENT_PROVIDERS.NAGAD, PAYMENT_PROVIDERS.BANK]),
  returnUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

export const listSubscriptionsSchema = paginationSchema.extend({
  status: z.string().optional(),
  tenantId: objectId.optional(),
});

export type AssignSubscriptionInput = z.infer<typeof assignSubscriptionSchema>;
export type ExtendSubscriptionInput = z.infer<typeof extendSubscriptionSchema>;
export type SetSubscriptionStatusInput = z.infer<typeof setSubscriptionStatusSchema>;
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type ListSubscriptionsInput = z.infer<typeof listSubscriptionsSchema>;
