import { z } from 'zod';

/**
 * Profile and contact fields only. `.strict()` rejects `ownerUserId`, `status`,
 * `trialUsedAt`, `_id` or anything else: who owns an account and whether it is
 * active are never client-writable.
 */
export const updateAccountSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is required').max(160),
    contactEmail: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email').max(160)]),
    contactPhone: z.string().trim().max(40),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code')
      .transform((value) => value.toUpperCase()),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
