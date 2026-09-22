import { z } from 'zod';
import { PAYMENT_METHODS } from '../../config/constants';
import { optionalEmailAddress, optionalPhoneNumber, optionalHttpUrl } from '../common/common.validators';

const receiptSchema = z.object({
  headerText: z.string().trim().max(200).optional(),
  footerText: z.string().trim().max(200).optional(),
  returnPolicy: z.string().trim().max(300).optional(),
  showLogo: z.boolean().optional(),
  showCashier: z.boolean().optional(),
  paperWidthMm: z.union([z.literal(48), z.literal(58), z.literal(78), z.literal(80)]).optional(),
});

const taxSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().trim().max(20).optional(),
  // Basis points keeps the rate an integer: 7.5% is stored as 750.
  rateBasisPoints: z.number().int().min(0).max(10_000).optional(),
  inclusive: z.boolean().optional(),
});

const wholeMinor = (label: string, min: number, max: number) =>
  z
    .number({ invalid_type_error: `${label} must be a number` })
    .refine(Number.isSafeInteger, { message: `${label} must be a whole number of poisha` })
    .refine((value) => value >= min && value <= max, { message: `${label} is out of range` });

/** Loyalty rules. Every value is minor units; zero or negative rates are refused. */
const loyaltySchema = z
  .object({
    enabled: z.boolean().optional(),
    // At least ৳1 of spend per point, at most ৳1,000,000.
    earnSpendMinor: wholeMinor('Spend per point', 100, 100_000_000).optional(),
    // At least ৳0.01, at most ৳10,000 per point.
    pointValueMinor: wholeMinor('Point value', 1, 1_000_000).optional(),
    // Free (0) up to ৳1,000,000.
    membershipFeeMinor: wholeMinor('Membership fee', 0, 100_000_000).optional(),
  })
  .strict();

/** Barcode label sizes: only the widths the label layouts are designed for. */
const labelsSchema = z
  .object({
    productWidthMm: z.union([z.literal(38), z.literal(48), z.literal(58)]).optional(),
    loyaltyCardWidthMm: z.union([z.literal(48), z.literal(58), z.literal(85)]).optional(),
    paper: z.enum(['sheet', 'roll']).optional(),
  })
  .strict();

export const createStoreSchema = z.object({
  name: z.string().trim().min(2, 'Store name is required').max(160),
  code: z.string().trim().min(2).max(16).regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and dashes only').optional(),
  phone: optionalPhoneNumber,
  email: optionalEmailAddress,
  address: z.string().trim().max(400).optional().default(''),
  currency: z.string().trim().length(3).toUpperCase().default('BDT'),
  invoicePrefix: z.string().trim().max(12).default('INV-'),
  returnPrefix: z.string().trim().max(12).default('RET-'),
  logoUrl: optionalHttpUrl,
  receiptLogoUrl: optionalHttpUrl,
  lowStockThreshold: z.number().int().min(0).max(10_000).default(5),
  paymentMethods: z.array(z.enum(PAYMENT_METHODS)).min(1).optional(),
  receipt: receiptSchema.optional(),
  tax: taxSchema.optional(),
  labels: labelsSchema.optional(),
});

export const updateStoreSchema = createStoreSchema.partial().extend({
  /** Needs the loyalty entitlement; checked in the service. */
  loyalty: loyaltySchema.optional(),
  /** Deactivating frees the branch slot without destroying its history. */
  isActive: z.boolean().optional(),
});

export type CreateStoreInput = z.infer<typeof createStoreSchema>;
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;
