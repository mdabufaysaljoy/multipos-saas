import { Schema, model } from 'mongoose';
import type { BaseDoc } from './types';

export const CATALOG_PLAN_STATUSES = ['active', 'inactive'] as const;
export type CatalogPlanStatus = (typeof CATALOG_PLAN_STATUSES)[number];

/** Stable plan code: lowercase, starts with a letter, never changes. */
export const CATALOG_PLAN_CODE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

export interface CatalogPlanMetadata {
  /**
   * The per-interval plan SKUs (`SubscriptionPlan.code`) this catalog plan
   * corresponds to, e.g. Professional -> `showroom-monthly` / `showroom-annual`.
   * Existing subscriptions, upgrade requests and payments keep pointing at
   * those codes; this is the compatibility map between the two.
   */
  legacyPlanCodes: { monthly: string | null; annual: string | null };
  highlights: string[];
}

/**
 * A plan in the universal subscription catalog: Starter, Professional,
 * Enterprise. The plan itself carries no price - prices live in `PlanPrice`,
 * per POS product and billing cycle, so Restaurant Professional can be priced
 * differently from Clothing Professional without changing this record.
 */
export interface CatalogPlanDoc extends BaseDoc {
  code: string;
  displayName: string;
  description: string;
  status: CatalogPlanStatus;
  sortOrder: number;
  /** Upgrade ladder position; higher is a better plan. */
  tier: number;
  metadata: CatalogPlanMetadata;
}

const catalogPlanSchema = new Schema<CatalogPlanDoc>(
  {
    code: { type: String, required: true, trim: true, lowercase: true, immutable: true, match: CATALOG_PLAN_CODE_PATTERN },
    displayName: { type: String, required: true, trim: true, maxlength: 40 },
    description: { type: String, trim: true, maxlength: 300, default: '' },
    status: { type: String, enum: [...CATALOG_PLAN_STATUSES], default: 'active' },
    sortOrder: { type: Number, default: 0, min: 0, max: 1000 },
    tier: { type: Number, default: 1, min: 0, max: 100 },
    metadata: {
      legacyPlanCodes: {
        monthly: { type: String, default: null },
        annual: { type: String, default: null },
      },
      highlights: { type: [String], default: [] },
    },
  },
  { timestamps: true },
);

catalogPlanSchema.index({ code: 1 }, { unique: true });
catalogPlanSchema.index({ status: 1, sortOrder: 1 });
catalogPlanSchema.index({ 'metadata.legacyPlanCodes.monthly': 1 });
catalogPlanSchema.index({ 'metadata.legacyPlanCodes.annual': 1 });

export const CatalogPlanModel = model<CatalogPlanDoc>('CatalogPlan', catalogPlanSchema);
