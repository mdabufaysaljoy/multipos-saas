import type { PosVertical } from './verticals';
import type { PlanFeatures, PlanLimits } from '../models/SubscriptionPlan';
import type { ErrorCode } from '../utils/ApiError';

/**
 * The entitlement catalogue: the ONE list of what a subscription can grant.
 *
 * Code asks for an entitlement by these stable keys - `advancedAnalytics`,
 * `products` - never by plan name or tier. Each key maps onto the field a plan
 * stores it in, so plans, overrides and snapshots keep their existing shape.
 *
 * Unlimited is stored as UNLIMITED (-1) and is never exposed as a number: the
 * engine reports it as `{ limit: null, unlimited: true }`.
 *
 * POS-specific entitlements (Clothing variants, Restaurant kitchen, Pharmacy
 * batch/expiry...) are added here with `verticals`, once those features exist.
 * A key scoped to other verticals is simply never granted to a workspace.
 */

export const UNLIMITED = -1;

interface FeatureDefinition {
  label: string;
  /** The plan feature flag that grants it. */
  planFeature?: keyof PlanFeatures;
  /** Granted when ANY of these plan flags is on (a module made of several features). */
  anyOf?: (keyof PlanFeatures)[];
  /** POS types it exists for. Omitted means every POS type. */
  verticals?: readonly PosVertical[];
  /** The error code a refusal carries. Existing codes are kept so API clients do not break. */
  errorCode?: ErrorCode;
}

interface LimitDefinition {
  label: string;
  /** Plural noun for messages: "up to 300 products". */
  noun: string;
  planLimit: keyof PlanLimits;
  unit: 'count' | 'bytes';
  verticals?: readonly PosVertical[];
}

export const ENTITLEMENT_FEATURES = {
  salesReports: { label: 'Sales reports', planFeature: 'salesReports' },
  advancedAnalytics: { label: 'Advanced Analytics', planFeature: 'advancedReports', errorCode: 'ADVANCED_ANALYTICS_REQUIRED' },
  customerManagement: { label: 'Customer management', planFeature: 'customerManagement' },
  inventoryLedger: { label: 'Inventory ledger', planFeature: 'inventoryLedger' },
  // Kept on LIMIT_EXCEEDED: that is what the branch routes have always answered.
  multiBranch: { label: 'Branch analytics', planFeature: 'multiStore', errorCode: 'LIMIT_EXCEEDED' },
  customRoles: { label: 'Custom roles', planFeature: 'customRoles' },
  dataExport: { label: 'Data export', planFeature: 'exportData' },
  prioritySupport: { label: 'Priority support', planFeature: 'prioritySupport' },
  smsMarketing: { label: 'SMS marketing', planFeature: 'smsMarketing' },
  emailMarketing: { label: 'Email marketing', planFeature: 'emailMarketing' },
  marketing: { label: 'Marketing', anyOf: ['smsMarketing', 'emailMarketing'] },
  imageOptimization: { label: 'Image optimisation', planFeature: 'imageOptimization' },
  // The tills that run a card program; a POS type not listed here never receives it.
  loyalty: { label: 'Loyalty program', planFeature: 'loyaltyProgram', verticals: ['clothing', 'supershop'] },
  // Separate from `dataExport` on purpose: import is on every plan, export is not.
  productImport: { label: 'Bulk product import', planFeature: 'productImport', verticals: ['clothing'] },
  supplierManagement: { label: 'Supplier management', planFeature: 'supplierManagement', verticals: ['clothing'] },
} as const satisfies Record<string, FeatureDefinition>;

export const ENTITLEMENT_LIMITS = {
  products: { label: 'Products', noun: 'products', planLimit: 'maxProducts', unit: 'count' },
  staff: { label: 'Staff accounts', noun: 'staff accounts', planLimit: 'maxStaff', unit: 'count' },
  branches: { label: 'Branches', noun: 'branches', planLimit: 'maxStores', unit: 'count' },
  customers: { label: 'Customer profiles', noun: 'customer profiles', planLimit: 'maxCustomers', unit: 'count' },
  monthlySales: { label: 'Sales this month', noun: 'sales per month', planLimit: 'maxMonthlySales', unit: 'count' },
  storage: { label: 'File storage', noun: 'bytes of storage', planLimit: 'maxStorageBytes', unit: 'bytes' },
  suppliers: { label: 'Suppliers', noun: 'suppliers', planLimit: 'maxSuppliers', unit: 'count', verticals: ['clothing'] },
} as const satisfies Record<string, LimitDefinition>;

export type FeatureEntitlementKey = keyof typeof ENTITLEMENT_FEATURES;
export type LimitEntitlementKey = keyof typeof ENTITLEMENT_LIMITS;

export const FEATURE_ENTITLEMENT_KEYS = Object.keys(ENTITLEMENT_FEATURES) as FeatureEntitlementKey[];
export const LIMIT_ENTITLEMENT_KEYS = Object.keys(ENTITLEMENT_LIMITS) as LimitEntitlementKey[];

export const featureDefinition = (key: FeatureEntitlementKey): FeatureDefinition => {
  const definition = (ENTITLEMENT_FEATURES as Record<string, FeatureDefinition>)[key];
  if (!definition) throw new Error(`Unknown entitlement "${key}"`);
  return definition;
};

export const limitDefinition = (key: LimitEntitlementKey): LimitDefinition => {
  const definition = (ENTITLEMENT_LIMITS as Record<string, LimitDefinition>)[key];
  if (!definition) throw new Error(`Unknown limit "${key}"`);
  return definition;
};
