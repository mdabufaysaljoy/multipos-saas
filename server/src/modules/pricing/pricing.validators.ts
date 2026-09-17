import { z } from 'zod';
import { POS_PRODUCT_CODE_PATTERN } from '../../config/verticals';
import { CATALOG_PLAN_CODE_PATTERN, CATALOG_PLAN_STATUSES } from '../../models/CatalogPlan';
import { BILLING_CYCLES } from '../../models/PlanPrice';
import { objectId } from '../common/common.validators';

const posType = z.string().trim().regex(POS_PRODUCT_CODE_PATTERN, 'Unknown POS type');
const plan = z.string().trim().regex(CATALOG_PLAN_CODE_PATTERN, 'Unknown plan');
const billingCycle = z.enum(BILLING_CYCLES);

// ------------------------------------------------------------------ public

export const catalogQuerySchema = z.object({ posType }).strict();

/**
 * What a client may send to learn a price: a POS type, a plan and a cycle.
 * `.strict()`: an `amount`, `price`, `discount` or anything else is rejected
 * outright, so nothing the client says can become part of the price.
 */
export const quoteSchema = z.object({ posType, plan, billingCycle }).strict();

/** Inside a workspace the POS type is the workspace's own - it cannot be sent. */
export const workspaceQuoteSchema = z.object({ plan, billingCycle }).strict();

// ------------------------------------------------------------------ admin

export const listPricesSchema = z
  .object({ posType: posType.optional(), plan: plan.optional(), billingCycle: billingCycle.optional() })
  .strict();

export const schedulePriceSchema = z
  .object({
    posType,
    plan,
    billingCycle,
    /** Integer minor units only: 199000 = BDT 1,990.00. Decimals and strings are refused. */
    amountMinor: z.number().int('Use whole minor units (poisha)').min(0).max(1_000_000_000),
    currency: z.string().trim().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code').default('BDT'),
    effectiveFrom: z.coerce.date().optional(),
    note: z.string().trim().max(200).optional().default(''),
  })
  .strict();

export const priceIdParams = z.object({ id: objectId });
export const setPriceActiveSchema = z.object({ active: z.boolean() }).strict();

export const planCodeParams = z.object({ code: plan }).strict();
export const updateCatalogPlanSchema = z
  .object({
    displayName: z.string().trim().min(2).max(40),
    description: z.string().trim().max(300),
    status: z.enum(CATALOG_PLAN_STATUSES),
    sortOrder: z.number().int().min(0).max(1000),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

export type CatalogQuery = z.infer<typeof catalogQuerySchema>;
export type QuoteBody = z.infer<typeof quoteSchema>;
export type WorkspaceQuoteBody = z.infer<typeof workspaceQuoteSchema>;
export type ListPricesQuery = z.infer<typeof listPricesSchema>;
export type SchedulePriceBody = z.infer<typeof schedulePriceSchema>;
export type UpdateCatalogPlanBody = z.infer<typeof updateCatalogPlanSchema>;
