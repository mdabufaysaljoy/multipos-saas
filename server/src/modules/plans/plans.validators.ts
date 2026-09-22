import { z } from 'zod';
import { BILLING_INTERVALS } from '../../config/constants';
import { minorAmount } from '../common/common.validators';
import { DEFAULT_POS_VERTICAL, POS_PRODUCT_CODE_PATTERN, POS_VERTICALS } from '../../config/verticals';
import { TRIAL_LENGTH_DAYS } from '../../services/subscription/trialPolicy';

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
  smsMarketing: z.boolean().default(false),
  emailMarketing: z.boolean().default(false),
  imageOptimization: z.boolean().default(false),
  loyaltyProgram: z.boolean().default(false),
});

export const planLimitsSchema = z.object({
  maxStaff: limitValue.default(2),
  maxProducts: limitValue.default(200),
  maxStores: limitValue.default(1),
  maxMonthlySales: limitValue.default(-1),
  maxCustomers: limitValue.default(-1),
  /** Bytes, not megabytes - the unit the storage layer actually measures. */
  maxStorageBytes: limitValue.default(-1),
});

/**
 * One vertical's differences from the plan default. `.strict()` at every level:
 * an unknown feature or limit key is rejected outright rather than silently
 * stored, so an override can only ever change entitlements that exist.
 */
export const verticalOverrideSchema = z
  .object({
    vertical: z.enum(POS_VERTICALS),
    isAvailable: z.boolean().default(true),
    features: planFeaturesSchema.partial().strict().default({}),
    limits: planLimitsSchema.partial().strict().default({}),
  })
  .strict();

export const verticalOverridesSchema = z
  .array(verticalOverrideSchema)
  .max(POS_VERTICALS.length)
  .refine((list) => new Set(list.map((entry) => entry.vertical)).size === list.length, {
    message: 'Each vertical may be listed only once',
  });

/** Which vertical's view of the catalogue to return. */
export const planCatalogQuerySchema = z.object({
  vertical: z.enum(POS_VERTICALS).default(DEFAULT_POS_VERTICAL),
});

export const createPlanSchema = z.object({
  code: z.string().trim().toLowerCase().min(2).max(60).regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and dashes'),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional().default(''),
  interval: z.enum(BILLING_INTERVALS),
  /** Prices live in the database, in minor units. Never hardcoded in code. */
  priceMinor: minorAmount,
  currency: z.string().trim().length(3).toUpperCase().default('BDT'),
  /** 0, or exactly the platform trial length: a plan either offers the free trial or it does not. */
  trialDays: z
    .number()
    .int()
    .refine((days) => days === 0 || days === TRIAL_LENGTH_DAYS, `Trial days must be 0 or ${TRIAL_LENGTH_DAYS}`)
    .default(0),
  features: planFeaturesSchema.partial().optional(),
  limits: planLimitsSchema.partial().optional(),
  // No default: on an update, leaving it out must not wipe existing overrides.
  verticalOverrides: verticalOverridesSchema.optional(),
  /**
   * The POS product this plan is sold to; null for a plan shared by every POS
   * type. Only the shape is checked here - it must exist in the POS catalog,
   * which the controller verifies. No default, for the same reason as above.
   */
  posProductCode: z.string().trim().regex(POS_PRODUCT_CODE_PATTERN, 'Unknown POS type').nullable().optional(),
  isActive: z.boolean().default(true),
  isPublic: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
  /** Upgrade ladder position; higher means a better plan. */
  tier: z.number().int().min(0).max(100).default(1),
});

export const updatePlanSchema = createPlanSchema.partial();

/** Admin plan list: every plan, one POS type's plans, or only shared plans. */
export const planAdminListQuerySchema = z
  .object({
    posProductCode: z.union([z.literal('shared'), z.string().trim().regex(POS_PRODUCT_CODE_PATTERN)]).optional(),
  })
  .strict();

export type PlanAdminListQuery = z.infer<typeof planAdminListQuerySchema>;

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
export type PlanCatalogQuery = z.infer<typeof planCatalogQuerySchema>;
