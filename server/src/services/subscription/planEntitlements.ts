import type { ClientSession, Types } from 'mongoose';
import { DEFAULT_POS_VERTICAL, POS_VERTICALS, type PosVertical } from '../../config/verticals';
import type { PlanFeatures, PlanLimits, VerticalOverride } from '../../models/SubscriptionPlan';
import { TenantModel } from '../../models/Tenant';

/**
 * Plans are platform-wide (Starter / Professional / Enterprise, one price
 * list), but what a plan INCLUDES can differ per POS vertical.
 *
 *   plan.features / plan.limits   the platform default - what Clothing gets
 *   plan.verticalOverrides[]      per-vertical changes to specific keys, plus
 *                                 whether the plan is offered for that vertical
 *
 * This is the only place the two are combined. Subscriptions freeze the
 * RESOLVED result (with the vertical) in their snapshot, so a later change to
 * an override never rewrites a period a customer has already bought.
 *
 * Merging is allow-listed: only known keys are read from an override, and only
 * values of the right type (booleans for features, integers >= -1 for limits).
 * A malformed override stored in the database therefore cannot inject a key or
 * an invalid limit - it is ignored and the default applies.
 */

export const FEATURE_KEYS = [
  'salesReports',
  'advancedReports',
  'customerManagement',
  'inventoryLedger',
  'multiStore',
  'customRoles',
  'exportData',
  'prioritySupport',
  'smsMarketing',
  'emailMarketing',
  'imageOptimization',
] as const satisfies readonly (keyof PlanFeatures)[];

export const LIMIT_KEYS = [
  'maxStaff',
  'maxProducts',
  'maxStores',
  'maxMonthlySales',
  'maxCustomers',
  'maxStorageBytes',
] as const satisfies readonly (keyof PlanLimits)[];

export interface PlanEntitlementSource {
  features?: Partial<PlanFeatures> | null;
  limits?: Partial<PlanLimits> | null;
  verticalOverrides?: VerticalOverride[] | null;
  /** Set on a POS-specific plan; null/absent on a shared plan. */
  posProductCode?: string | null;
}

/**
 * A POS-specific plan is offered to workspaces of that POS type only. Shared
 * plans (no code - every plan that existed before) are offered to all.
 */
export const isPlanScopedElsewhere = (plan: { posProductCode?: string | null }, vertical: PosVertical): boolean =>
  Boolean(plan.posProductCode) && plan.posProductCode !== vertical;

export interface ResolvedPlanEntitlements {
  vertical: PosVertical;
  /** False when the platform does not sell this plan to this vertical. */
  isAvailable: boolean;
  features: PlanFeatures;
  limits: PlanLimits;
}

export const isPosVertical = (value: unknown): value is PosVertical =>
  typeof value === 'string' && (POS_VERTICALS as readonly string[]).includes(value);

const isLimitValue = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= -1;

export function resolvePlanForVertical(
  plan: PlanEntitlementSource,
  vertical: PosVertical = DEFAULT_POS_VERTICAL,
): ResolvedPlanEntitlements {
  const override = (plan.verticalOverrides ?? []).find((entry) => entry?.vertical === vertical);

  // Keys absent from the base plan stay absent, exactly as a snapshot of the
  // plan always was; the entitlement layer decides how to treat a missing key.
  const features: Partial<PlanFeatures> = {};
  for (const key of FEATURE_KEYS) {
    const overridden = override?.features?.[key];
    const value = typeof overridden === 'boolean' ? overridden : plan.features?.[key];
    if (typeof value === 'boolean') features[key] = value;
  }

  const limits: Partial<PlanLimits> = {};
  for (const key of LIMIT_KEYS) {
    const overridden = override?.limits?.[key];
    const value = isLimitValue(overridden) ? overridden : plan.limits?.[key];
    if (typeof value === 'number') limits[key] = value;
  }

  return {
    vertical,
    // Every purchase path (checkout, wallet, manual request, admin assignment,
    // coupons, plan options, pricing) asks this one question.
    isAvailable: !isPlanScopedElsewhere(plan, vertical) && (override ? override.isAvailable !== false : true),
    features: features as PlanFeatures,
    limits: limits as PlanLimits,
  };
}

/**
 * A plan as a given vertical sees it: resolved features and limits, and none of
 * the override configuration (which is platform-admin data, not a price list).
 */
export function planForVertical<T extends PlanEntitlementSource>(plan: T, vertical: PosVertical) {
  const { verticalOverrides: _config, ...rest } = plan;
  const resolved = resolvePlanForVertical(plan, vertical);
  return { ...rest, vertical, features: resolved.features, limits: resolved.limits };
}

/** A workspace's vertical, read from the database. Legacy rows are Clothing. */
export async function verticalOfTenant(tenantId: Types.ObjectId, session?: ClientSession): Promise<PosVertical> {
  const tenant = await TenantModel.findById(tenantId).select('vertical').session(session ?? null).lean();
  return isPosVertical(tenant?.vertical) ? tenant.vertical : DEFAULT_POS_VERTICAL;
}
