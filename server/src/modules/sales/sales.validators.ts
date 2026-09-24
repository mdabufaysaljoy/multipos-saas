import { z } from 'zod';
import { PAYMENT_METHODS } from '../../config/constants';
import { minorAmount, objectId, positiveIntegerQuantity, positiveMinorAmount, searchSchema, calendarDate } from '../common/common.validators';
import { posCustomerSchema } from '../customers/customers.validators';

/**
 * A checkout line.
 *
 * These two refinements are the backend half of the "never 0.001" guarantee:
 * quantity must be a whole number >= 1, and an overridden price must be a whole
 * number of minor units > 0. A cart may hold 0 while the cashier is editing,
 * but a checkout carrying a 0 never gets past this schema.
 */
export const saleItemInputSchema = z.object({
  variantId: objectId,
  quantity: positiveIntegerQuantity,
  /**
   * Optional price override. Omit to charge the catalogue price. Supplying a
   * value that differs from the catalogue price requires sales.changePrice.
   */
  unitPriceMinor: minorAmount
    .refine((value) => value > 0, { message: 'Price must be greater than zero' })
    .optional(),
});

export const createSaleSchema = z
  .object({
    items: z.array(saleItemInputSchema).min(1, 'Add at least one item to the cart'),

    // Customer information is entirely optional at checkout.
    customerId: objectId.nullable().optional(),
    customer: posCustomerSchema.optional(),

    discountType: z.enum(['none', 'fixed', 'percent']).default('none'),
    /** Minor units when type is "fixed"; basis points (1% = 100) when "percent". */
    discountValue: z.number().int().min(0).default(0),

    /** The primary tender. For a split payment this is the largest row. */
    paymentMethod: z.enum(PAYMENT_METHODS),
    /**
     * Split-payment breakdown. When present this is AUTHORITATIVE: the amount
     * paid is the sum of these rows, not the client's `paidMinor`. Every row
     * must be a positive integer amount, so a split can never contain a zero or
     * negative allocation.
     */
    payments: z
      .array(
        z.object({
          method: z.enum(PAYMENT_METHODS),
          amountMinor: positiveMinorAmount,
          reference: z.string().trim().max(80).optional().default(''),
        }),
      )
      .max(10, 'A sale can use at most 10 payment methods')
      .optional(),
    /** Amount tendered when a single method is used. */
    paidMinor: minorAmount.optional(),
    /**
     * Physical cash the customer handed over. When present, `payments` are the
     * amounts APPLIED to the sale (they must add up to exactly the total), and
     * the surplus of this over the cash row is change - never revenue.
     */
    cashTenderedMinor: minorAmount.optional(),

    note: z.string().trim().max(500).optional().default(''),

    /**
     * The loyalty card scanned at the till. Points earned, point values and the
     * discount are all worked out on the server; only WHICH card and HOW MANY
     * points to spend come from the client, and both are checked.
     */
    loyaltyMembershipId: objectId.optional(),
    redeemPoints: z
      .number()
      .refine(Number.isSafeInteger, { message: 'Points must be a whole number' })
      .refine((value) => value >= 0 && value <= 100_000_000, { message: 'Enter a valid number of points' })
      .optional(),
    /** One key per checkout attempt; a retry with the same key returns the first sale. */
    idempotencyKey: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/, 'Invalid request key').optional(),
  })
  .superRefine((data, ctx) => {
    if ((data.redeemPoints ?? 0) > 0 && !data.loyaltyMembershipId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['redeemPoints'], message: 'Scan the loyalty card before redeeming points' });
    }
    if (data.discountType === 'percent' && data.discountValue > 10_000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['discountValue'], message: 'A percentage discount cannot exceed 100%' });
    }
    if (data.discountType === 'none' && data.discountValue !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['discountValue'], message: 'Select a discount type before entering a value' });
    }
    // A split payment may not list the same method twice - combine the rows
    // instead, so the stored breakdown has one entry per tender.
    if (data.payments && data.payments.length > 1) {
      const methods = new Set<string>();
      data.payments.forEach((payment, index) => {
        if (methods.has(payment.method)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['payments', index, 'method'],
            message: `"${payment.method}" appears twice - combine it into a single row`,
          });
        }
        methods.add(payment.method);
      });
    }

    // Guard against the same variant appearing twice, which would split the
    // stock check across two lines and confuse returns.
    const seen = new Set<string>();
    data.items.forEach((item, index) => {
      const key = String(item.variantId);
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'variantId'], message: 'This item is already in the cart - increase its quantity instead' });
      }
      seen.add(key);
    });
  });

export const listSalesSchema = searchSchema.extend({
  /** Owners only: include sales from every branch, deleted ones included. */
  allBranches: z.coerce.boolean().optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  cashierId: objectId.optional(),
  customerId: objectId.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(['completed', 'cancelled']).optional(),
});

export const cancelSaleSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason for cancelling').max(300),
});

export type SaleItemInput = z.infer<typeof saleItemInputSchema>;
export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type ListSalesInput = z.infer<typeof listSalesSchema>;
export type CancelSaleInput = z.infer<typeof cancelSaleSchema>;
