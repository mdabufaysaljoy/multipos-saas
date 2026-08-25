import { z } from 'zod';
import { BILLING_INTERVALS } from '../../config/constants';
import { minorAmount } from '../common/common.validators';

const limitValue = z
  .number()
  .int()
  .min(-1, 'Use -1 for unlimited')
  .describe('-1 means unlimited');

export const planFeaturesSchema = z.object({
  salesReports: z.boolean().default(true),
  advancedReports: z.boolean().default(false),
  customerManagement: z.boolean().default(true),
  inventoryLedger: z.boolean().default(true),
  multiStore: z.boolean().default(false),
  customRoles: z.boolean().default(false),
  exportData: z.boolean().default(false),
  prioritySupport: z.boolean().default(false),
});

export const planLimitsSchema = z.object({
  maxStaff: limitValue.default(2),
  maxProducts: limitValue.default(200),
  maxStores: limitValue.default(1),
  maxMonthlySales: limitValue.default(-1),
});

export const createPlanSchema = z.object({
  code: z.string().trim().toLowerCase().min(2).max(60).regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and dashes'),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional().default(''),
  interval: z.enum(BILLING_INTERVALS),
  /** Prices live in the database, in minor units. Never hardcoded in code. */
  priceMinor: minorAmount,
  currency: z.string().trim().length(3).toUpperCase().default('BDT'),
  trialDays: z.number().int().min(0).max(365).default(0),
  features: planFeaturesSchema.partial().optional(),
  limits: planLimitsSchema.partial().optional(),
  isActive: z.boolean().default(true),
  isPublic: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});

export const updatePlanSchema = createPlanSchema.partial();

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
