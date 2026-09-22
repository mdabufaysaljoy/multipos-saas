import { z } from 'zod';
import { PAYMENT_METHODS } from '../../config/constants';
import { minorAmount, objectId, paginationSchema, positiveMinorAmount } from '../common/common.validators';

const idempotencyKey = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/, 'Invalid request key');

/** The barcode as a scanner types it. Only the card's own digits are ever looked up. */
export const lookupSchema = z.object({
  code: z.string().trim().min(4, 'Scan a loyalty card').max(40),
});

export const listMembershipsSchema = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const historySchema = paginationSchema;

export const customerParam = z.object({ customerId: objectId });

/**
 * Issuing a card. No fee, card number, barcode or points are accepted: the fee
 * comes from the store's loyalty settings and everything else is generated.
 * `payments` are the amounts APPLIED to the fee (they must add up to it exactly);
 * cash handed over beyond the cash row is change, as at the till.
 */
export const issueMembershipSchema = z
  .object({
    customerId: objectId,
    payments: z
      .array(
        z.object({
          method: z.enum(PAYMENT_METHODS),
          amountMinor: positiveMinorAmount,
          reference: z.string().trim().max(80).optional().default(''),
        }),
      )
      .max(10)
      .optional(),
    cashTenderedMinor: minorAmount.optional(),
    idempotencyKey,
  })
  .strict();

export const setStatusSchema = z
  .object({
    status: z.enum(['active', 'inactive']),
    reason: z.string().trim().min(3, 'Give a reason').max(300),
  })
  .strict();

export const adjustPointsSchema = z
  .object({
    points: z
      .number()
      .refine(Number.isSafeInteger, { message: 'Points must be a whole number' })
      .refine((value) => value !== 0 && Math.abs(value) <= 1_000_000, { message: 'Enter a non-zero adjustment up to 1,000,000 points' }),
    reason: z.string().trim().min(5, 'Give a reason for the adjustment').max(300),
    idempotencyKey,
  })
  .strict();

export type ListMembershipsInput = z.infer<typeof listMembershipsSchema>;
export type IssueMembershipInput = z.infer<typeof issueMembershipSchema>;
export type SetStatusInput = z.infer<typeof setStatusSchema>;
export type AdjustPointsInput = z.infer<typeof adjustPointsSchema>;
