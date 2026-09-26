import { z } from 'zod';
import { SHOP_UNIT_TYPES } from '../../models/ShopProduct';
import { MAX_BASE_QUANTITY } from '../../models/shopUnits';
import { SHOP_SALE_STATUSES } from '../../models/ShopSale';
import { objectId, paginationSchema, searchSchema, paymentMethodKey, calendarDate } from '../common/common.validators';
import { RANGE_PRESETS } from '../reports/reports.validators';
import { posCustomerSchema } from '../customers/customers.validators';

/**
 * A single item's price or cost: at most 1,000,000.00.
 *
 * Kept deliberately lower than a sale amount, because a unit price is
 * MULTIPLIED by a quantity: this ceiling times the largest quantity a line may
 * carry stays inside `Number.isSafeInteger`, so a line total can never silently
 * lose precision. `createSale` re-checks the product anyway.
 */
const amount = z.number().int().min(0).max(100_000_000);

/**
 * Money that belongs to a whole sale - a payment, or a discount.
 *
 * A basket is not bounded by what one item costs: a supershop takes wholesale
 * runs and appliance sales, and a payment row has to be able to carry one. The
 * ceiling is 100,000,000.00, which is also just above the most a till's money
 * input will accept, so anything a cashier can type is something the server will
 * take. Five rows at the ceiling still add up well inside a safe integer.
 *
 * It is a bound, not an absence of one: a mistyped amount is still refused, and
 * the message says what the limit is instead of leaving the till with "the
 * submitted data is not valid".
 */
export const MAX_SALE_AMOUNT_MINOR = 10_000_000_000;
const saleAmount = z
  .number()
  .int('Amounts must be a whole number of poisha')
  .min(0)
  .max(MAX_SALE_AMOUNT_MINOR, 'One payment cannot be more than 100,000,000.00. Split it across tenders.');
const text = (max: number) => z.string().trim().max(max);
/**
 * Pieces, or grams for weighed goods.
 *
 * This is only the outer bound - the widest any unit type allows. The real
 * ceiling depends on the product's `unitType`, which the schema cannot see, so
 * the service applies it once the product has been read (`assertWithinUnitMax`).
 */
const baseQuantity = z.number().int().min(1).max(MAX_BASE_QUANTITY);

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
    reorderLevel: z.number().int().min(0).max(MAX_BASE_QUANTITY).default(0),
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
    reorderLevel: z.number().int().min(0).max(MAX_BASE_QUANTITY),
    isActive: z.boolean(),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

export const listProductsSchema = searchSchema.extend({
  category: z.string().trim().max(60).optional(),
  /** Exact brand name, as `/brands` lists them. Free text on the product today. */
  brand: z.string().trim().max(80).optional(),
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
      .min(-MAX_BASE_QUANTITY)
      .max(MAX_BASE_QUANTITY)
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
      .array(z.object({ method: paymentMethodKey, amountMinor: saleAmount }).strict())
      .min(1, 'Record how the customer paid')
      .max(5, 'A sale can be split across at most five payment methods'),
    discountMinor: saleAmount.default(0),
    customerId: objectId.optional(),
    customer: posCustomerSchema.optional(),
    /**
     * The loyalty card scanned at the till. Only a scanned card earns or
     * redeems - never a phone number, and never a customer on their own.
     */
    loyaltyMembershipId: objectId.optional(),
    redeemPoints: z.number().int().min(0).max(1_000_000).default(0),
    note: text(300).optional().default(''),
  })
  .strict();

/**
 * A return: which lines came back, how many of each, and whether the goods went
 * back on the shelf. Prices are never sent - the server refunds what was paid.
 */
export const createReturnSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            saleItemId: objectId,
            quantity: z.number().int().min(1).max(MAX_BASE_QUANTITY),
            /** False leaves the goods out of stock: damaged, opened, expired. */
            restock: z.boolean().default(true),
          })
          .strict(),
      )
      .min(1, 'Choose at least one line to return')
      .max(100),
    reason: z.string().trim().min(3, 'Give a reason for the return').max(300),
    refundMethod: paymentMethodKey.default('cash'),
  })
  .strict();

/**
 * An exchange: the same returned lines a refund would take, plus the
 * replacement basket and whatever the customer pays on top.
 *
 * No prices are sent. The server values the returned goods from the ORIGINAL
 * sale and the replacement from today's catalogue, which is what makes the
 * "not cheaper" rule something a till cannot talk its way around.
 */
export const createExchangeSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            saleItemId: objectId,
            quantity: z.number().int().min(1).max(MAX_BASE_QUANTITY),
            /** False leaves the goods out of stock: damaged, opened, expired. */
            restock: z.boolean().default(true),
          })
          .strict(),
      )
      .min(1, 'Choose at least one line to exchange')
      .max(100),
    replacement: z
      .object({
        items: z
          .array(z.object({ productId: objectId, quantity: baseQuantity }).strict())
          .min(1, 'Choose the replacement goods')
          .max(200)
          .refine((items) => new Set(items.map((item) => String(item.productId))).size === items.length, 'List each replacement product once'),
        /** Empty when the replacement costs exactly what came back. */
        payments: z
          .array(z.object({ method: paymentMethodKey, amountMinor: saleAmount }).strict())
          .max(5, 'An exchange can be split across at most five payment methods')
          .default([]),
      })
      .strict(),
    reason: z.string().trim().min(3, 'Give a reason for the exchange').max(300),
    /**
     * Makes a repeated submission - a double click, a retried request - return
     * the first exchange instead of running it a second time.
     */
    idempotencyKey: z.string().trim().min(8, 'An exchange needs a request key').max(100),
  })
  .strict();

/**
 * Parking a basket. No prices and no totals: the server reads them from the
 * catalogue for the list, and reads them again from the catalogue on resume.
 */
export const holdSaleSchema = z
  .object({
    items: z
      .array(z.object({ productId: objectId, quantity: baseQuantity }).strict())
      .min(1, 'There is nothing to hold')
      .max(200)
      .refine((items) => new Set(items.map((item) => String(item.productId))).size === items.length, 'List each product once'),
    /** What the cashier calls it, to find it again: "blue jacket", "table 3". */
    label: text(60).optional().default(''),
    discountMinor: saleAmount.default(0),
    customerId: objectId.optional(),
    customer: posCustomerSchema.optional(),
    /** The card that was scanned, by number: resuming looks it up again. */
    loyaltyCardNumber: text(64).optional().default(''),
    note: text(300).optional().default(''),
  })
  .strict();

export const voidSaleSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(200) }).strict();

export const listSalesSchema = searchSchema.extend({
  status: z.enum(SHOP_SALE_STATUSES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/**
 * Advanced Analytics filters.
 *
 * Two kinds, and the difference matters:
 *   SALE-level  branch, staff, payment method, customer - they choose which
 *               sales are counted, so every figure narrows with them.
 *   LINE-level  category, brand, product - they choose which LINES are of
 *               interest. They narrow the sale set to the sales containing such
 *               a line and narrow the per-line breakdowns, and the `selection`
 *               block reports those lines on their own. Sale totals stay sale
 *               totals: a basket is not re-costed because one line was asked
 *               about.
 */
export const shopAnalyticsSchema = z
  .object({
    preset: z.enum(RANGE_PRESETS).default('last7'),
    from: calendarDate.optional(),
    to: calendarDate.optional(),
    /** 'current' (default), 'all' or one branch id. Anything but your own branch needs admin. */
    branch: z.union([z.literal('current'), z.literal('all'), objectId]).default('current'),
    staffId: objectId.optional(),
    customerId: objectId.optional(),
    paymentMethod: paymentMethodKey.optional(),
    category: z.string().trim().max(60).optional(),
    brand: z.string().trim().max(80).optional(),
    productId: objectId.optional(),
    /** How many rows each breakdown returns. */
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.preset === 'custom' && (!data.from || !data.to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'A custom range needs both a start and an end date' });
    }
    if (data.from && data.to && data.from > data.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'The end date must be after the start date' });
    }
  });

export type ShopAnalyticsInput = z.infer<typeof shopAnalyticsSchema>;

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListProductsInput = z.infer<typeof listProductsSchema>;
export type ReceiveStockInput = z.infer<typeof receiveStockSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export type ListMovementsInput = z.infer<typeof listMovementsSchema>;
export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type ListSalesInput = z.infer<typeof listSalesSchema>;
export type CreateReturnInput = z.infer<typeof createReturnSchema>;
export type CreateExchangeInput = z.infer<typeof createExchangeSchema>;
export type HoldSaleInput = z.infer<typeof holdSaleSchema>;
