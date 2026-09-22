import { z } from 'zod';
import { minorAmount, nonNegativeIntegerQuantity, objectId, searchSchema, httpUrl } from '../common/common.validators';

const skuField = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(64)
  .regex(/^[A-Z0-9._-]+$/, 'SKU may contain letters, numbers, dots, dashes and underscores');

export const variantInputSchema = z.object({
  name: z.string().trim().max(160).optional(),
  attributes: z
    .array(z.object({ name: z.string().trim().min(1).max(40), value: z.string().trim().min(1).max(60) }))
    .max(5)
    .default([]),
  sku: skuField.optional(),
  barcode: z.string().trim().max(64).nullable().optional(),
  // Price and stock are integers by construction: minor units and whole pieces.
  sellingPriceMinor: minorAmount,
  costPriceMinor: minorAmount.default(0),
  stock: nonNegativeIntegerQuantity.default(0),
  lowStockThreshold: nonNegativeIntegerQuantity.default(0),
  isActive: z.boolean().default(true),
});

export const createProductSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required').max(200),
  sku: skuField.optional(),
  categoryId: objectId.nullable().optional(),
  description: z.string().trim().max(2000).optional().default(''),
  brand: z.string().trim().max(120).optional().default(''),
  images: z
    .array(z.object({ url: httpUrl, key: z.string().max(512).nullable().default(null), isPrimary: z.boolean().default(false) }))
    .max(10)
    .default([]),
  options: z
    .array(z.object({ name: z.string().trim().min(1).max(40), values: z.array(z.string().trim().min(1).max(60)).min(1).max(50) }))
    .max(3)
    .default([]),
  isActive: z.boolean().default(true),
  /** At least one sellable variant is always required. */
  variants: z.array(variantInputSchema).min(1, 'A product needs at least one variant'),
});

export const updateProductSchema = createProductSchema.omit({ variants: true }).partial();

export const createVariantSchema = variantInputSchema;
export const updateVariantSchema = variantInputSchema
  .omit({ stock: true })
  .partial()
  .describe('Stock is deliberately not editable here - use the inventory endpoints so every change is ledgered');

export const listProductsSchema = searchSchema.extend({
  categoryId: objectId.optional(),
  includeInactive: z.coerce.boolean().default(false),
  lowStockOnly: z.coerce.boolean().default(false),
  outOfStockOnly: z.coerce.boolean().default(false),
});

export const posSearchSchema = z.object({
  q: z.string().trim().max(120).optional().default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  categoryId: objectId.optional(),
  inStockOnly: z.coerce.boolean().default(false),
});

/**
 * The POS product grid, paged by PRODUCT (not variant): a product with twelve
 * size/colour variants is one card and counts once toward the page. Search and
 * category are applied in the database before paging, so every page is a true
 * slice of the filtered catalogue.
 */
export const posCatalogSchema = z
  .object({
    q: z.string().trim().max(120).optional().default(''),
    categoryId: objectId.optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(60).default(24),
  })
  .strict();

export type VariantInput = z.infer<typeof variantInputSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListProductsInput = z.infer<typeof listProductsSchema>;
export type PosSearchInput = z.infer<typeof posSearchSchema>;
export type PosCatalogInput = z.infer<typeof posCatalogSchema>;
export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;
