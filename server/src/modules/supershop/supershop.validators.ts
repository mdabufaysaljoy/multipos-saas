import { z } from 'zod';
import { PAYMENT_METHODS } from '../../config/constants';
import { SHOP_UNIT_TYPES } from '../../models/ShopProduct';
import { SHOP_SALE_STATUSES } from '../../models/ShopSale';
import { objectId, paginationSchema, searchSchema } from '../common/common.validators';

const amount = z.number().int().min(0).max(100_000_000);
const text = (max: number) => z.string().trim().max(max);
/** Pieces, or grams for weighed goods: up to 1,000,000 (1 tonne). */
const baseQuantity = z.number().int().min(1).max(1_000_000);

/** "true"/"false" from a query string. `z.coerce.boolean` would read "false" as true. */
const queryFlag = z.enum(['true', 'false']).optional().transform((value) => value === 'true');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-03-31');

// --------------------------------------------------------------- products

export const createProductSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(120),
    brand: text(80).optional().default(''),
    category: text(60).optional().default('General'),
    barcode: z
      .string()
      .trim()
      .max(64)
      .regex(/^[A-Za-z0-9-]*$/, 'A barcode may only contain letters, numbers and -')
      .optional()
      .default(''),
    unitType: z.enum(SHOP_UNIT_TYPES).default('each'),
    priceMinor: amount,
    vatRateBps: z.number().int().min(0).max(10_000).default(0),
    reorderLevel: z.number().int().min(0).max(1_000_000).default(0),
    isActive: z.boolean().default(true),
  })
  .strict();

/** `unitType` is fixed once created: existing stock and sales are counted in it. */
export const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    brand: text(80),
    category: z.string().trim().min(1).max(60),
    barcode: z.string().trim().max(64).regex(/^[A-Za-z0-9-]*$/, 'A barcode may only contain letters, numbers and -'),
    priceMinor: amount,
    vatRateBps: z.number().int().min(0).max(10_000),
    reorderLevel: z.number().int().min(0).max(1_000_000),
    isActive: z.boolean(),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

export const listProductsSchema = searchSchema.extend({
  category: z.string().trim().max(60).optional(),
  activeOnly: queryFlag,
  lowStockOnly: queryFlag,
});

export const barcodeQuerySchema = z.object({ barcode: z.string().trim().min(1).max(64) }).strict();

// ------------------------------------------------------------------ stock

export const receiveStockSchema = z
  .object({
    quantity: baseQuantity,
    /** Per piece or per kilogram. */
    costPriceMinor: amount,
    supplierName: text(120).optional().default(''),
  })
  .strict();

export const adjustStockSchema = z
  .object({
    type: z.enum(['adjust', 'write_off']),
    quantityDelta: z
      .number()
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .refine((value) => value !== 0, 'The change cannot be zero'),
    reason: z.string().trim().min(3, 'Give a reason').max(200),
  })
  .strict()
  .refine((input) => input.type !== 'write_off' || input.quantityDelta < 0, {
    path: ['quantityDelta'],
    message: 'A write-off removes stock',
  });

export const listMovementsSchema = paginationSchema.extend({ productId: objectId.optional() });

// ------------------------------------------------------------------ sales

/** A line names a product and a quantity only. Prices and costs come from the server. */
const saleLine = z.object({ productId: objectId, quantity: baseQuantity }).strict();

export const createSaleSchema = z
  .object({
    items: z
      .array(saleLine)
      .min(1, 'Add at least one item')
      .max(200)
      .refine((items) => new Set(items.map((item) => String(item.productId))).size === items.length, 'List each product once'),
    payments: z
      .array(z.object({ method: z.enum(PAYMENT_METHODS), amountMinor: amount }).strict())
      .min(1, 'Record how the customer paid')
      .max(5),
    discountMinor: amount.default(0),
    customerId: objectId.optional(),
    note: text(300).optional().default(''),
  })
  .strict();

export const voidSaleSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(200) }).strict();

export const listSalesSchema = searchSchema.extend({
  status: z.enum(SHOP_SALE_STATUSES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListProductsInput = z.infer<typeof listProductsSchema>;
export type ReceiveStockInput = z.infer<typeof receiveStockSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export type ListMovementsInput = z.infer<typeof listMovementsSchema>;
export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type ListSalesInput = z.infer<typeof listSalesSchema>;
