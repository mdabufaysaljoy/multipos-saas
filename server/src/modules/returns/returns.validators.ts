import { z } from 'zod';
import { PAYMENT_METHODS } from '../../config/constants';
import { objectId, positiveIntegerQuantity, searchSchema, calendarDate } from '../common/common.validators';

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
    refundMethod: z.enum(PAYMENT_METHODS).default('cash'),
  })
  .superRefine((data, ctx) => {
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
