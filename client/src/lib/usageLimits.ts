import { formatBytes } from '@/lib/planCatalog';

/**
 * How close a workspace is to each of its plan limits.
 *
 * One definition of the thresholds, so the subscription page, the contextual
 * banners and any future surface all agree on what "nearly full" means.
 *
 * The server enforces the ceiling regardless; this exists so a customer is
 * warned before they hit it rather than surprised by a refusal mid-sale.
 */

export type UsageLevel = 'ok' | 'warning' | 'critical' | 'full';

export const WARNING_AT = 80;
export const CRITICAL_AT = 90;

export interface UsageLimitKey {
  /** Key in `entitlement.limits`. */
  limit: string;
  /** Key in `usage`. */
  usage: string;
  label: string;
  /** Plural noun for sentences: "add more products". */
  noun: string;
  format?: 'bytes';
  /** Where the customer goes to free some up. */
  href?: string;
}

export const USAGE_LIMITS: UsageLimitKey[] = [
  { limit: 'maxProducts', usage: 'products', label: 'Products', noun: 'products', href: '/catalogue' },
  { limit: 'maxStaff', usage: 'staff', label: 'Staff accounts', noun: 'staff accounts', href: '/staff' },
  { limit: 'maxStores', usage: 'stores', label: 'Branches', noun: 'branches', href: '/branches' },
  { limit: 'maxCustomers', usage: 'customers', label: 'Customer profiles', noun: 'customer profiles', href: '/customers' },
  { limit: 'maxMonthlySales', usage: 'monthlySales', label: 'Sales this month', noun: 'sales this month' },
  { limit: 'maxStorageBytes', usage: 'storageBytes', label: 'File storage', noun: 'storage', format: 'bytes' },
  { limit: 'maxSuppliers', usage: 'suppliers', label: 'Suppliers', noun: 'suppliers', href: '/suppliers' },
];

/**
 * The meters as a vertical names them. The server counts `products` and
 * `monthlySales` in the vertical's own records (menu items and orders for a
 * Restaurant), so only the wording and the link change here.
 */
export function usageLimitsFor(vertical: string | null | undefined): UsageLimitKey[] {
  if (vertical !== 'restaurant') return USAGE_LIMITS;
  return USAGE_LIMITS.map((definition) => {
    if (definition.usage === 'products') return { ...definition, label: 'Menu items', noun: 'menu items', href: '/menu' };
    if (definition.usage === 'monthlySales') return { ...definition, label: 'Orders this month', noun: 'orders this month', href: '/orders' };
    return definition;
  });
}

export interface UsageStatus extends UsageLimitKey {
  used: number;
  max: number;
  /** True when the plan places no ceiling on this. */
  unlimited: boolean;
  percent: number;
  level: UsageLevel;
  usedLabel: string;
  maxLabel: string;
  remaining: number;
}

const fmt = (value: number, format?: 'bytes') =>
  format === 'bytes' ? formatBytes(Math.max(0, value)) : value.toLocaleString();

export function evaluateUsage(
  definition: UsageLimitKey,
  used: number,
  max: number,
): UsageStatus {
  const unlimited = max === -1;
  // An unlimited resource has no meaningful percentage, and must never warn.
  const percent = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, max)) * 100));

  let level: UsageLevel = 'ok';
  if (!unlimited) {
    if (used >= max) level = 'full';
    else if (percent >= CRITICAL_AT) level = 'critical';
    else if (percent >= WARNING_AT) level = 'warning';
  }

  return {
    ...definition,
    used,
    max,
    unlimited,
    percent,
    level,
    usedLabel: fmt(used, definition.format),
    maxLabel: unlimited ? 'Unlimited' : fmt(max, definition.format),
    remaining: unlimited ? Infinity : Math.max(0, max - used),
  };
}

/** The sentence shown to the customer, or null when nothing needs saying. */
export function usageMessage(status: UsageStatus, planName: string | null): string | null {
  if (status.level === 'ok') return null;

  const of = `${status.usedLabel} of ${status.maxLabel}`;

  if (status.level === 'full') {
    return `You have used all ${status.maxLabel} ${status.noun} included in ${planName ?? 'your plan'}. Upgrade to add more.`;
  }
  if (status.level === 'critical') {
    return `You have used ${of} ${status.noun}. Upgrade soon to avoid interruption.`;
  }
  return `You have used ${of} ${status.noun}.`;
}
