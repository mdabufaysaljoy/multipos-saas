import { Schema, model } from 'mongoose';
import { BILLING_INTERVALS } from '../config/constants';
import { POS_VERTICALS, type PosVertical } from '../config/verticals';
import type { BaseDoc } from './types';

export interface PlanLimits {
  /** -1 means unlimited. */
  maxStaff: number;
  maxProducts: number;
  maxStores: number;
  /** Sales recorded in the current calendar month. */
  maxMonthlySales: number;
  maxCustomers: number;
  /** Total bytes of uploaded files the workspace may hold. */
  maxStorageBytes: number;
}

export interface PlanFeatures {
  salesReports: boolean;
  advancedReports: boolean;
  customerManagement: boolean;
  inventoryLedger: boolean;
  multiStore: boolean;
  customRoles: boolean;
  exportData: boolean;
  prioritySupport: boolean;
  /**
   * Access to the marketing module. Sending itself is billed per message from
   * the wallet, so this flag governs availability, not spend.
   */
  smsMarketing: boolean;
  emailMarketing: boolean;
  /**
   * Automatic Image Optimization & WebP Conversion.
   *
   * Brand only. Uploads are resized, compressed and stored as WebP, so a
   * high-resolution photo costs a fraction of the quota.
   */
  imageOptimization: boolean;
  /** Loyalty points and membership cards (Clothing POS). Professional and Enterprise. */
  loyaltyProgram: boolean;
  /**
   * Bulk product import from Excel/CSV (Clothing POS). Included on EVERY plan -
   * it is how a new shop gets its catalogue in, not a tier differentiator. The
   * flag exists so it stays independently enforceable (and separately from
   * `exportData`), never so a plan can be sold without it.
   */
  productImport: boolean;
}

/**
 * How one POS vertical's version of a plan differs from the platform default.
 * Only the keys present change; everything else comes from `features`/`limits`.
 * Resolved in exactly one place: `services/subscription/planEntitlements.ts`.
 */
export interface VerticalOverride {
  vertical: PosVertical;
  /** False when the plan is not sold to this vertical at all. */
  isAvailable: boolean;
  features: Partial<PlanFeatures>;
  limits: Partial<PlanLimits>;
}

/** Pricing lives in the database - never hardcoded in application code. */
export interface SubscriptionPlanDoc extends BaseDoc {
  code: string;
  name: string;
  description: string;
  interval: string;
  priceMinor: number;
  currency: string;
  trialDays: number;
  /** The platform default - what a Clothing workspace receives. */
  features: PlanFeatures;
  limits: PlanLimits;
  /** Per-vertical differences. Empty means every vertical gets the default. */
  verticalOverrides: VerticalOverride[];
  /**
   * The platform POS product (catalog code) this plan is sold to, e.g.
   * `restaurant`. `null` - every plan that predates POS-specific plans - means a
   * shared plan offered to every POS type (still subject to `verticalOverrides`).
   */
  posProductCode: string | null;
  isActive: boolean;
  isPublic: boolean;
  sortOrder: number;
  /**
   * Upgrade ladder position. A customer may only move to a plan with a HIGHER
   * tier than their current one. Configurable per plan so the platform admin
   * controls the ladder rather than it being inferred from price.
   */
  tier: number;
}

const verticalOverrideSchema = new Schema<VerticalOverride>(
  {
    vertical: { type: String, enum: [...POS_VERTICALS], required: true },
    isAvailable: { type: Boolean, default: true },
    // Mixed, because an override holds only the keys it changes. Values are
    // validated on the way in (plans.validators) and allow-listed on the way
    // out (planEntitlements), so neither side trusts the other.
    features: { type: Schema.Types.Mixed, default: {} },
    limits: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false, minimize: false },
);

const planSchema = new Schema<SubscriptionPlanDoc>(
  {
    code: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    interval: { type: String, enum: [...BILLING_INTERVALS], required: true },
    priceMinor: { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'priceMinor must be an integer' } },
    currency: { type: String, default: 'BDT', uppercase: true },
    trialDays: { type: Number, default: 0, min: 0 },
    features: {
      salesReports: { type: Boolean, default: true },
      advancedReports: { type: Boolean, default: false },
      customerManagement: { type: Boolean, default: true },
      inventoryLedger: { type: Boolean, default: true },
      multiStore: { type: Boolean, default: false },
      customRoles: { type: Boolean, default: false },
      exportData: { type: Boolean, default: false },
      prioritySupport: { type: Boolean, default: false },
      smsMarketing: { type: Boolean, default: false },
      emailMarketing: { type: Boolean, default: false },
      imageOptimization: { type: Boolean, default: false },
      loyaltyProgram: { type: Boolean, default: false },
      productImport: { type: Boolean, default: true },
    },
    limits: {
      maxStaff: { type: Number, default: 2 },
      maxProducts: { type: Number, default: 200 },
      maxStores: { type: Number, default: 1 },
      maxMonthlySales: { type: Number, default: -1 },
      maxCustomers: { type: Number, default: -1 },
      maxStorageBytes: { type: Number, default: -1 },
    },
    verticalOverrides: { type: [verticalOverrideSchema], default: [] },
    // Checked against the POS catalog on the way in (planScope.service).
    posProductCode: { type: String, trim: true, lowercase: true, default: null },
    isActive: { type: Boolean, default: true, index: true },
    isPublic: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    tier: { type: Number, default: 1, min: 0 },
  },
  { timestamps: true },
);

planSchema.index({ code: 1 }, { unique: true });
planSchema.index({ interval: 1, isActive: 1, sortOrder: 1 });
// "Plans for this POS type" (catalog counts, admin filter, scope checks).
planSchema.index({ posProductCode: 1, isActive: 1 });

export const SubscriptionPlanModel = model<SubscriptionPlanDoc>('SubscriptionPlan', planSchema);
