import type { Types } from 'mongoose';
import {
  ENTITLEMENT_FEATURES,
  ENTITLEMENT_LIMITS,
  FEATURE_ENTITLEMENT_KEYS,
  LIMIT_ENTITLEMENT_KEYS,
  UNLIMITED,
  featureDefinition,
  limitDefinition,
  type FeatureEntitlementKey,
  type LimitEntitlementKey,
} from '../../config/entitlements';
import { DEFAULT_POS_VERTICAL, type PosVertical } from '../../config/verticals';
import { AccountModel } from '../../models/Account';
import type { PlanFeatures } from '../../models/SubscriptionPlan';
import { TenantModel } from '../../models/Tenant';
import { ApiError } from '../../utils/ApiError';
import { entitlementService } from '../subscription/entitlement.service';
import { isPosVertical } from '../subscription/planEntitlements';

export type AccessBlock = 'workspace_not_found' | 'workspace_suspended' | 'account_suspended' | 'no_subscription' | 'subscription_inactive';

export interface LimitValue {
  /** null when unlimited - unlimited is never a number. */
  limit: number | null;
  unlimited: boolean;
}

export interface WorkspaceEntitlements {
  workspaceId: Types.ObjectId;
  accountId: Types.ObjectId | null;
  posProductCode: PosVertical;
  subscription: { status: string; planCode: string | null; planName: string | null; currentPeriodEnd: Date | null } | null;
  /** Whether the chain grants anything at all, and why not. */
  access: { usable: boolean; reason: AccessBlock | null };
  features: Record<FeatureEntitlementKey, boolean>;
  limits: Record<LimitEntitlementKey, LimitValue>;
}

export interface LimitCheck extends LimitValue {
  key: LimitEntitlementKey;
  used: number;
  adding: number;
  /** null when unlimited. */
  remaining: number | null;
  allowed: boolean;
  reason: AccessBlock | 'limit_reached' | null;
}

const appliesTo = (verticals: readonly PosVertical[] | undefined, vertical: PosVertical) => !verticals || verticals.includes(vertical);

/**
 * Resolves what a workspace is entitled to, along the whole chain:
 *
 *   account (not suspended)
 *   -> workspace (exists, not suspended)
 *   -> POS product (the workspace's vertical)
 *   -> subscription (usable: active, trial, or in grace)
 *   -> plan snapshot (features and limits resolved for that vertical when bought)
 *   -> entitlements
 *
 * A broken link grants nothing: every feature is off and every limit is 0.
 * Plan names and tiers play no part - only the plan's feature flags and limits.
 */
export async function resolveEntitlements(workspaceId: Types.ObjectId): Promise<WorkspaceEntitlements> {
  const workspace = await TenantModel.findById(workspaceId).select('_id accountId vertical status').lean();
  const posProductCode: PosVertical = isPosVertical(workspace?.vertical) ? workspace.vertical : DEFAULT_POS_VERTICAL;
  const [account, entitlement] = await Promise.all([
    workspace?.accountId ? AccountModel.findById(workspace.accountId).select('status').lean() : null,
    workspace ? entitlementService.forTenant(workspace._id) : null,
  ]);

  let reason: AccessBlock | null = null;
  if (!workspace || !entitlement) reason = 'workspace_not_found';
  else if (workspace.status === 'suspended') reason = 'workspace_suspended';
  else if (workspace.accountId && (!account || account.status === 'suspended')) reason = 'account_suspended';
  else if (!entitlement.planCode) reason = 'no_subscription';
  else if (!entitlement.isUsable) reason = 'subscription_inactive';
  const usable = reason === null;

  const planFeatures = (entitlement?.features ?? {}) as Partial<PlanFeatures>;
  const features = Object.fromEntries(
    FEATURE_ENTITLEMENT_KEYS.map((key) => {
      const definition = featureDefinition(key);
      const granted = definition.anyOf
        ? definition.anyOf.some((flag) => planFeatures[flag] === true)
        : definition.planFeature
          ? planFeatures[definition.planFeature] === true
          : false;
      return [key, usable && appliesTo(definition.verticals, posProductCode) && granted];
    }),
  ) as Record<FeatureEntitlementKey, boolean>;

  const limits = Object.fromEntries(
    LIMIT_ENTITLEMENT_KEYS.map((key) => {
      const definition = limitDefinition(key);
      if (!usable || !appliesTo(definition.verticals, posProductCode)) return [key, { limit: 0, unlimited: false }];
      const raw = entitlement!.limits?.[definition.planLimit];
      if (raw === UNLIMITED) return [key, { limit: null, unlimited: true }];
      return [key, { limit: typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0, unlimited: false }];
    }),
  ) as Record<LimitEntitlementKey, LimitValue>;

  return {
    workspaceId,
    accountId: workspace?.accountId ?? null,
    posProductCode,
    subscription: entitlement?.planCode
      ? { status: entitlement.status, planCode: entitlement.planCode, planName: entitlement.planName, currentPeriodEnd: entitlement.currentPeriodEnd }
      : null,
    access: { usable, reason },
    features,
    limits,
  };
}

/** Whether a workspace is entitled to a feature. */
export async function hasEntitlement(workspaceId: Types.ObjectId, key: FeatureEntitlementKey): Promise<boolean> {
  featureDefinition(key);
  return (await resolveEntitlements(workspaceId)).features[key];
}

/** A workspace's limit for a countable resource. */
export async function getLimit(workspaceId: Types.ObjectId, key: LimitEntitlementKey): Promise<LimitValue & { key: LimitEntitlementKey }> {
  limitDefinition(key);
  return { key, ...(await resolveEntitlements(workspaceId)).limits[key] };
}

/** Current usage of a limited resource, counted on the server - never taken from a client. */
async function countUsage(workspaceId: Types.ObjectId, key: LimitEntitlementKey, vertical: PosVertical): Promise<number> {
  switch (key) {
    case 'products':
      return entitlementService.countProducts(workspaceId, vertical);
    case 'staff':
      return entitlementService.countStaff(workspaceId);
    case 'branches':
      return entitlementService.countStores(workspaceId);
    case 'customers':
      return entitlementService.countCustomers(workspaceId);
    case 'monthlySales':
      return entitlementService.countMonthlySales(workspaceId, vertical);
    case 'storage':
      return entitlementService.storageBytes(workspaceId);
  }
}

/**
 * Whether a workspace may add `adding` more of a resource (default 1; bytes for
 * storage). A pre-check for the UI and for services; the create paths keep
 * their race-safe ordinal checks as the final word.
 */
export async function checkLimit(
  workspaceId: Types.ObjectId,
  key: LimitEntitlementKey,
  options: { adding?: number; resolved?: WorkspaceEntitlements } = {},
): Promise<LimitCheck> {
  limitDefinition(key);
  const resolved = options.resolved ?? (await resolveEntitlements(workspaceId));
  const value = resolved.limits[key];
  const adding = Math.max(0, options.adding ?? 1);
  const used = await countUsage(workspaceId, key, resolved.posProductCode);
  const fits = value.unlimited || used + adding <= (value.limit ?? 0);
  const allowed = resolved.access.usable && fits;
  return {
    key,
    ...value,
    used,
    adding,
    remaining: value.unlimited ? null : Math.max(0, (value.limit ?? 0) - used),
    allowed,
    reason: !resolved.access.usable ? resolved.access.reason : allowed ? null : 'limit_reached',
  };
}

const blockedError = (resolved: WorkspaceEntitlements) => {
  switch (resolved.access.reason) {
    case 'workspace_not_found':
      return ApiError.notFound('Workspace not found');
    case 'workspace_suspended':
      return ApiError.forbidden('This workspace has been suspended. Please contact support.');
    case 'account_suspended':
      return ApiError.forbidden('This account is suspended. Please contact support.');
    default:
      return ApiError.subscriptionInactive('Your subscription is not active. Choose a plan to continue.', {
        reason: resolved.access.reason,
        status: resolved.subscription?.status ?? null,
      });
  }
};

/** Throws unless the workspace is entitled to the feature. */
export async function assertEntitlement(workspaceId: Types.ObjectId, key: FeatureEntitlementKey, resolved?: WorkspaceEntitlements): Promise<WorkspaceEntitlements> {
  const definition = featureDefinition(key);
  const current = resolved ?? (await resolveEntitlements(workspaceId));
  if (!current.access.usable) throw blockedError(current);
  if (current.features[key]) return current;
  throw new ApiError(definition.errorCode ?? 'ENTITLEMENT_REQUIRED', `${definition.label} is not included in your plan.`, {
    entitlement: key,
    posProductCode: current.posProductCode,
  });
}

/** Throws unless the workspace may add `adding` more of the resource. */
export async function assertLimit(workspaceId: Types.ObjectId, key: LimitEntitlementKey, options: { adding?: number } = {}): Promise<LimitCheck> {
  const resolved = await resolveEntitlements(workspaceId);
  if (!resolved.access.usable) throw blockedError(resolved);
  const check = await checkLimit(workspaceId, key, { ...options, resolved });
  if (check.allowed) return check;
  const definition = limitDefinition(key);
  throw ApiError.limitExceeded(`Your plan allows up to ${check.limit} ${definition.noun}. Upgrade to add more.`, {
    entitlement: key,
    limit: check.limit,
    used: check.used,
  });
}

/** Everything a workspace is entitled to, with usage for every limit - for screens and support. */
export async function describeEntitlements(workspaceId: Types.ObjectId) {
  const resolved = await resolveEntitlements(workspaceId);
  const limits = Object.fromEntries(
    await Promise.all(
      LIMIT_ENTITLEMENT_KEYS.map(async (key) => {
        const check = await checkLimit(workspaceId, key, { resolved });
        const definition = ENTITLEMENT_LIMITS[key];
        return [key, { label: definition.label, unit: definition.unit, limit: check.limit, unlimited: check.unlimited, used: check.used, remaining: check.remaining, canAddMore: check.allowed }];
      }),
    ),
  );
  const features = Object.fromEntries(FEATURE_ENTITLEMENT_KEYS.map((key) => [key, { label: ENTITLEMENT_FEATURES[key].label, enabled: resolved.features[key] }]));
  return { ...resolved, features, limits };
}

export const entitlementEngine = { resolveEntitlements, hasEntitlement, getLimit, checkLimit, assertEntitlement, assertLimit, describeEntitlements };
