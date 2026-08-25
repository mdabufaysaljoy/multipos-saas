import { z } from 'zod';
import { PAYMENT_METHODS } from '../../config/constants';

const receiptSchema = z.object({
  headerText: z.string().trim().max(200).optional(),
  footerText: z.string().trim().max(200).optional(),
  returnPolicy: z.string().trim().max(300).optional(),
  showLogo: z.boolean().optional(),
  showCashier: z.boolean().optional(),
  paperWidthMm: z.union([z.literal(58), z.literal(78), z.literal(80)]).optional(),
});

const taxSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().trim().max(20).optional(),
  // Basis points keeps the rate an integer: 7.5% is stored as 750.
  rateBasisPoints: z.number().int().min(0).max(10_000).optional(),
  inclusive: z.boolean().optional(),
});

export const createStoreSchema = z.object({
  name: z.string().trim().min(2, 'Store name is required').max(160),
  code: z.string().trim().min(2).max(16).regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and dashes only').optional(),
  phone: z.string().trim().max(32).optional().default(''),
  email: z.string().trim().toLowerCase().email().or(z.literal('')).optional().default(''),
  address: z.string().trim().max(400).optional().default(''),
  currency: z.string().trim().length(3).toUpperCase().default('BDT'),
  invoicePrefix: z.string().trim().max(12).default('INV-'),
  returnPrefix: z.string().trim().max(12).default('RET-'),
  logoUrl: z.string().url().nullable().optional(),
  lowStockThreshold: z.number().int().min(0).max(10_000).default(5),
  paymentMethods: z.array(z.enum(PAYMENT_METHODS)).min(1).optional(),
  receipt: receiptSchema.optional(),
  tax: taxSchema.optional(),
});

export const updateStoreSchema = createStoreSchema.partial();

export type CreateStoreInput = z.infer<typeof createStoreSchema>;
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;
