import { z } from 'zod';
import { DOSAGE_FORMS } from '../../models/Medicine';
import { PHARMACY_SALE_STATUSES } from '../../models/PharmacySale';
import { objectId, paginationSchema, searchSchema, paymentMethodKey } from '../common/common.validators';
import { posCustomerSchema } from '../customers/customers.validators';

const amount = z.number().int().min(0).max(100_000_000);
const text = (max: number) => z.string().trim().max(max);

/** "true"/"false" from a query string. `z.coerce.boolean` would read "false" as true. */
const queryFlag = z.enum(['true', 'false']).optional().transform((value) => value === 'true');

/** A calendar date, YYYY-MM-DD. Stored as that day at 00:00 UTC. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-03-31')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'That is not a real date');

// -------------------------------------------------------------- medicines

export const createMedicineSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(120),
    genericName: text(120).optional().default(''),
    strength: text(40).optional().default(''),
    dosageForm: z.enum(DOSAGE_FORMS).default('tablet'),
    manufacturer: text(120).optional().default(''),
    category: text(60).optional().default('General'),
    barcode: text(64).optional().default(''),
    sellingPriceMinor: amount,
    requiresPrescription: z.boolean().default(false),
    reorderLevel: z.number().int().min(0).max(1_000_000).default(0),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateMedicineSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    genericName: text(120),
    strength: text(40),
    dosageForm: z.enum(DOSAGE_FORMS),
    manufacturer: text(120),
    category: z.string().trim().min(1).max(60),
    barcode: text(64),
    sellingPriceMinor: amount,
    requiresPrescription: z.boolean(),
    reorderLevel: z.number().int().min(0).max(1_000_000),
    isActive: z.boolean(),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

export const listMedicinesSchema = searchSchema.extend({
  activeOnly: queryFlag,
  /** Only medicines with unexpired stock in the current branch. */
  inStockOnly: queryFlag,
});

// ------------------------------------------------------------------ stock

export const receiveBatchSchema = z
  .object({
    batchNumber: z
      .string()
      .trim()
      .min(1, 'Batch number is required')
      .max(40)
      .regex(/^[A-Za-z0-9._/-]+$/, 'Use letters, numbers and . _ / - only'),
    expiryDate: isoDate,
    quantity: z.number().int().min(1).max(1_000_000),
    costPriceMinor: amount,
    supplierName: text(120).optional().default(''),
  })
  .strict();

export const listBatchesSchema = paginationSchema.extend({
  status: z.enum(['in_stock', 'expiring', 'expired']).default('in_stock'),
  /** For `expiring`: batches expiring within this many days. */
  days: z.coerce.number().int().min(1).max(365).default(30),
  medicineId: objectId.optional(),
});

export const adjustBatchSchema = z
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

export const listMovementsSchema = paginationSchema.extend({
  medicineId: objectId.optional(),
  batchId: objectId.optional(),
});

// ------------------------------------------------------------------ sales

/**
 * A sale line names a medicine and a quantity - nothing else. `.strict()`
 * rejects a client-supplied price or batch: the server prices from the
 * catalogue and picks the batches itself.
 */
const saleLine = z.object({ medicineId: objectId, quantity: z.number().int().min(1).max(10_000) }).strict();

export const createSaleSchema = z
  .object({
    items: z
      .array(saleLine)
      .min(1, 'Add at least one medicine')
      .max(100)
      .refine((items) => new Set(items.map((item) => String(item.medicineId))).size === items.length, 'List each medicine once'),
    payments: z
      .array(z.object({ method: paymentMethodKey, amountMinor: amount }).strict())
      .min(1, 'Record how the customer paid')
      .max(5),
    discountMinor: amount.default(0),
    customerId: objectId.optional(),
    customer: posCustomerSchema.optional(),
    prescription: z
      .object({
        patientName: z.string().trim().min(2, "Enter the patient's name").max(120),
        prescriberName: z.string().trim().min(2, "Enter the prescriber's name").max(120),
        prescriptionNumber: text(60).optional().default(''),
        note: text(300).optional().default(''),
      })
      .strict()
      .optional(),
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
            quantity: z.number().int().min(1).max(1_000_000),
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

export const voidSaleSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(200) }).strict();

export const listSalesSchema = searchSchema.extend({
  status: z.enum(PHARMACY_SALE_STATUSES).optional(),
  prescriptionOnly: queryFlag,
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export type CreateMedicineInput = z.infer<typeof createMedicineSchema>;
export type UpdateMedicineInput = z.infer<typeof updateMedicineSchema>;
export type ListMedicinesInput = z.infer<typeof listMedicinesSchema>;
export type ReceiveBatchInput = z.infer<typeof receiveBatchSchema>;
export type ListBatchesInput = z.infer<typeof listBatchesSchema>;
export type AdjustBatchInput = z.infer<typeof adjustBatchSchema>;
export type ListMovementsInput = z.infer<typeof listMovementsSchema>;
export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type ListSalesInput = z.infer<typeof listSalesSchema>;
export type CreateReturnInput = z.infer<typeof createReturnSchema>;
