import { Types } from 'mongoose';
import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../config/constants';

/** Accepts a 24-char hex id and hands back a real ObjectId. */
export const objectId = z
  .string()
  .refine((value) => Types.ObjectId.isValid(value), { message: 'Invalid id' })
  .transform((value) => new Types.ObjectId(value));

export const idParam = z.object({ id: objectId });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const searchSchema = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  sort: z.string().trim().max(40).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * A whole, positive count. Rejects 1.5, "1e3", NaN and Infinity, which is the
 * backend half of the guarantee that a quantity can never become 0.001.
 */
export const positiveIntegerQuantity = z
  .number({ invalid_type_error: 'Quantity must be a number' })
  .refine(Number.isSafeInteger, { message: 'Quantity must be a whole number' })
  .refine((value) => value > 0, { message: 'Quantity must be at least 1' });

/** Same, but permits 0 - used where a draft value is legitimately zero. */
export const nonNegativeIntegerQuantity = z
  .number({ invalid_type_error: 'Quantity must be a number' })
  .refine(Number.isSafeInteger, { message: 'Quantity must be a whole number' })
  .refine((value) => value >= 0, { message: 'Quantity cannot be negative' });

/** Money in minor units. Always an integer; never a float. */
export const minorAmount = z
  .number({ invalid_type_error: 'Amount must be a number' })
  .refine(Number.isSafeInteger, { message: 'Amount must be a whole number of minor units' })
  .refine((value) => value >= 0, { message: 'Amount cannot be negative' });

export const positiveMinorAmount = minorAmount.refine((value) => value > 0, {
  message: 'Amount must be greater than zero',
});

export const dateRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  preset: z.enum(['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'thisYear', 'custom']).optional(),
});
