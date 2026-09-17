import type { SubscriptionPlanDoc } from '../../models/SubscriptionPlan';
import { formatBytes } from '../../utils/formatBytes';

export type TransitionKind = 'current' | 'upgrade' | 'cycle-change' | 'downgrade';

export interface TransitionVerdict {
  kind: TransitionKind;
  /** Can the customer move onto this plan by paying, with no cleanup? */
  allowedDirect: boolean;
  /** True when the move needs the resource-limit check to pass first. */
  requiresResourceCheck: boolean;
  reason: string;
}

type PlanLike = Pick<SubscriptionPlanDoc, 'code' | 'name' | 'tier' | 'interval'>;

/**
 * The plan × billing-cycle transition matrix.
 *
 * Two INDEPENDENT dimensions:
 *   - PLAN LEVEL   Starter(1) < Showroom(2) < Brand(3), compared by `tier`
 *   - BILLING CYCLE  monthly / annual
 *
 * The rules, deliberately simple:
 *
 *   1. SAME PLAN, different cycle  -> always allowed, no cleanup.
 *      Includes annual -> monthly (e.g. Brand Annual -> Brand Monthly). The
 *      plan's limits do not change, so there is nothing to validate and no
 *      reason to force a cancellation.
 *
 *   2. HIGHER PLAN -> always allowed, regardless of cycle combination.
 *      Limits only ever grow, so cleanup is impossible to require.
 *
 *   3. LOWER PLAN -> a downgrade. Allowed only once the tenant fits inside the
 *      target plan's limits. If they already fit, it proceeds with no cleanup.
 *
 * Single source of truth: the API and the plan cards both call this, so they
 * can never disagree about what is offered.
 */
export function classifyTransition(current: PlanLike | null, target: PlanLike): TransitionVerdict {
  if (!current) {
    return { kind: 'upgrade', allowedDirect: true, requiresResourceCheck: false, reason: '' };
  }

  if (current.code === target.code) {
    return { kind: 'current', allowedDirect: false, requiresResourceCheck: false, reason: 'This is your current plan.' };
  }

  // Rule 1 - same plan level, only the billing cycle differs.
  if (target.tier === current.tier) {
    return { kind: 'cycle-change', allowedDirect: true, requiresResourceCheck: false, reason: '' };
  }

  // Rule 2 - moving up.
  if (target.tier > current.tier) {
    return { kind: 'upgrade', allowedDirect: true, requiresResourceCheck: false, reason: '' };
  }

  // Rule 3 - moving down. Whether it is allowed depends on current usage,
  // which the caller resolves with `findLimitBreaches`.
  return {
    kind: 'downgrade',
    allowedDirect: false,
    requiresResourceCheck: true,
    reason: `${target.name} has lower limits than ${current.name}. Your usage must fit inside the new plan before you can move.`,
  };
}

export interface LimitBreach {
  resource: string;
  label: string;
  current: number;
  limit: number;
  excess: number;
  action: string;
}

export interface TenantUsage {
  /** Decides what the `products` meter is called: menu items for Restaurant. */
  vertical?: string;
  branches: number;
  staff: number;
  products: number;
  customers: number;
  storageBytes: number;
}

export interface PlanLimits {
  maxStores: number;
  maxStaff: number;
  maxProducts: number;
  maxCustomers: number;
  maxStorageBytes: number;
}

/**
 * What currently stops a tenant fitting inside a target plan.
 *
 * Returns the exact excess per resource so the customer can be told precisely
 * what to remove. Nothing is ever deleted automatically - cleanup is always the
 * owner's decision. An empty array means the downgrade can proceed as-is.
 */
export function findLimitBreaches(usage: TenantUsage, limits: PlanLimits): LimitBreach[] {
  const breaches: LimitBreach[] = [];

  const check = (resource: string, label: string, current: number, limit: number, verb: string) => {
    // -1 means unlimited.
    if (limit === -1 || current <= limit) return;
    const excess = current - limit;
    breaches.push({
      resource,
      label,
      current,
      limit,
      excess,
      action: `${verb} ${excess.toLocaleString()} ${excess === 1 ? label.replace(/s$/, '') : label}`,
    });
  };

  check('branches', 'branches', usage.branches, limits.maxStores, 'Remove or deactivate');
  check('staff', 'staff', usage.staff, limits.maxStaff, 'Remove or deactivate');
  check('products', usage.vertical === 'restaurant' ? 'menu items' : 'products', usage.products, limits.maxProducts, 'Reduce by');
  check('customers', 'customers', usage.customers, limits.maxCustomers, 'Reduce by');

  // Storage is bytes, so the generic counter's "remove N customers" phrasing
  // would be nonsense. It gets its own message.
  if (limits.maxStorageBytes !== -1 && usage.storageBytes > limits.maxStorageBytes) {
    const excess = usage.storageBytes - limits.maxStorageBytes;
    breaches.push({
      resource: 'storage',
      label: 'storage',
      current: usage.storageBytes,
      limit: limits.maxStorageBytes,
      excess,
      action: `Free up ${formatBytes(excess)} of files`,
    });
  }

  return breaches;
}

/** Convenience: the full verdict for one target plan, usage included. */
export function evaluateTransition(
  current: PlanLike | null,
  target: PlanLike & { limits: PlanLimits },
  usage: TenantUsage,
): TransitionVerdict & { breaches: LimitBreach[]; canProceed: boolean } {
  const verdict = classifyTransition(current, target);
  const breaches = verdict.requiresResourceCheck ? findLimitBreaches(usage, target.limits) : [];

  // A downgrade whose limits are already satisfied proceeds with no cleanup.
  const canProceed = verdict.kind === 'current' ? false : verdict.allowedDirect || breaches.length === 0;

  return { ...verdict, breaches, canProceed };
}
