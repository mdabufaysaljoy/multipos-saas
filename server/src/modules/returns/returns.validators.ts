import { z } from 'zod';
import { minorAmount, objectId, positiveIntegerQuantity, positiveMinorAmount, searchSchema, calendarDate, paymentMethodKey } from '../common/common.validators';

/** The refund method that turns a return into a replacement sale instead of a payout. */
export const EXCHANGE_REFUND_METHOD = 'exchange' as const;

export const createReturnSchema = z
  .object({
    /** A return ALWAYS references an existing sale; there is no standalone form. */
    saleId: objectId,
    items: z
      .array(
        z.object({
          /** The specific line of the original sale being returned. */
          saleItemId: objectId,
          quantity: positiveIntegerQuantity,
          /** false for damaged goods that should not go back on the shelf. */
          restock: z.boolean().default(true),
        }),
      )
      .min(1, 'Select at least one item to return'),
    reason: z.string().trim().max(500).optional().default(''),
    /** A payment method, or "exchange": the refund value goes into replacement goods instead. */
    refundMethod: z.union([paymentMethodKey, z.literal(EXCHANGE_REFUND_METHOD)]).default('cash'),
    /**
     * Required for an exchange, refused otherwise. Only WHAT is taken and how
     * the extra is paid - never a price, a refund value or an amount due; the
     * server works all of those out.
     */
    exchange: z
      .object({
        /** The exact variants the customer takes instead. */
        items: z
          .array(z.object({ variantId: objectId, quantity: positiveIntegerQuantity }).strict())
          .min(1, 'Select the replacement product')
          .max(20),
        payments: z
          .array(
            z
              .object({
                method: paymentMethodKey,
                amountMinor: positiveMinorAmount,
                reference: z.string().trim().max(80).optional().default(''),
              })
              .strict(),
          )
          .max(10)
          .optional(),
        cashTenderedMinor: minorAmount.optional(),
        /** One exchange per key: a retry returns the first result instead of exchanging again. */
        idempotencyKey: z.string().trim().min(8).max(100),
      })
      .strict()
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.refundMethod === EXCHANGE_REFUND_METHOD && !data.exchange) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['exchange'], message: 'Select the replacement product for this exchange' });
    }
    if (data.refundMethod !== EXCHANGE_REFUND_METHOD && data.exchange) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['exchange'], message: 'Replacement products are only used with the Exchange refund method' });
    }
    if (data.exchange?.payments) {
      const methods = new Set<string>();
      data.exchange.payments.forEach((payment, index) => {
        if (methods.has(payment.method)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['exchange', 'payments', index, 'method'], message: `"${payment.method}" appears twice - combine it into a single row` });
        }
        methods.add(payment.method);
      });
    }
    if (data.exchange) {
      const variants = new Set<string>();
      data.exchange.items.forEach((item, index) => {
        if (variants.has(String(item.variantId))) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['exchange', 'items', index, 'variantId'], message: 'This replacement appears twice - combine it into a single quantity' });
        }
        variants.add(String(item.variantId));
      });
    }
    const seen = new Set<string>();
    data.items.forEach((item, index) => {
      const key = String(item.saleItemId);
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'saleItemId'],
          message: 'This line appears twice - combine it into a single quantity',
        });
      }
      seen.add(key);
    });
  });

export const listReturnsSchema = searchSchema.extend({
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  saleId: objectId.optional(),
});

export type CreateReturnInput = z.infer<typeof createReturnSchema>;
export type ListReturnsInput = z.infer<typeof listReturnsSchema>;
