import { z } from 'zod';
import { INVENTORY_TX_TYPES } from '../../config/constants';
import { objectId, paginationSchema, searchSchema, calendarDate } from '../common/common.validators';

export const adjustStockSchema = z.object({
  variantId: objectId,
  /** "set" writes an absolute count; "delta" adds or subtracts. */
  mode: z.enum(['set', 'delta']).default('delta'),
  // Whole numbers only - a fractional adjustment is never valid for clothing.
  value: z
    .number({ invalid_type_error: 'Enter a whole number' })
    .refine(Number.isSafeInteger, { message: 'Stock must be a whole number' }),
  reason: z.string().trim().min(2, 'Give a reason for this adjustment').max(300),
});

export const STOCK_SORTS = [
  'name',
  'stockAsc',
  'stockDesc',
  'newest',
  'oldest',
  'valueDesc',
] as const;

export const listStockSchema = searchSchema.extend({
  categoryId: objectId.optional(),
  lowStockOnly: z.coerce.boolean().default(false),
  outOfStockOnly: z.coerce.boolean().default(false),
  /** Sorting happens in MongoDB, not the browser, so it works past page 1. */
  sortBy: z.enum(STOCK_SORTS).default('stockAsc'),
});

export const ledgerSchema = paginationSchema.extend({
  variantId: objectId.optional(),
  productId: objectId.optional(),
  type: z.enum(Object.values(INVENTORY_TX_TYPES) as [string, ...string[]]).optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});

export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export type ListStockInput = z.infer<typeof listStockSchema>;
export type LedgerInput = z.infer<typeof ledgerSchema>;
