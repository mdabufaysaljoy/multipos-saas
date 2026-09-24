import { z } from 'zod';
import { paymentMethodKey } from '../common/common.validators';

export const createPaymentMethodSchema = z
  .object({
    /** What the till and the receipt show. */
    label: z.string().trim().min(2, 'Give the method a name').max(40),
    /**
     * Optional: the stable key stored on every payment line. Derived from the
     * label when it is left out, and never changed afterwards - it is what a
     * sale from last year says.
     */
    key: paymentMethodKey.optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  })
  .strict();

export const updatePaymentMethodSchema = z
  .object({
    label: z.string().trim().min(2).max(40),
    isActive: z.boolean(),
    sortOrder: z.number().int().min(0).max(999),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

export type CreatePaymentMethodInput = z.infer<typeof createPaymentMethodSchema>;
export type UpdatePaymentMethodInput = z.infer<typeof updatePaymentMethodSchema>;
