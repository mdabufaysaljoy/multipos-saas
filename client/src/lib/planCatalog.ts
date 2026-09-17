import type { SubscriptionPlan } from '@/types/domain';

/**
 * What the pricing page shows, in one place.
 *
 * Three rules keep this honest:
 *
 *   1. Every VALUE comes from the API. This file holds labels, ordering and
 *      grouping - never a number or a boolean. A limit printed here can never
 *      disagree with the limit the backend enforces, because it is the same
 *      number.
 *   2. A `flag` row names a key in `plan.features`, and every one of those keys
 *      is enforced somewhere on the server. A flag that gates nothing is a
 *      promise the backend cannot keep, so it does not get a row.
 *   3. An `always` row is a capability that genuinely ships on every plan. It
 *      is listed so buyers can see what "the full point of sale" actually
 *      means, not to pad the table.
 *
 * Deliberately absent: warehouses, purchase orders, suppliers, expenses, stock
 * transfers, approval workflows, sales targets, marketing automation, demand
 * forecasting and a public API. None of them exist in this build, and a pricing
 * page is the worst possible place to describe software that has not been
 * written.
 */

export type PlanRow =
  /** A number read from `plan.limits`. */
  | { kind: 'limit'; key: string; label: string; hint?: string; format?: 'bytes' }
  /**
   * A boolean read from `plan.features`, enforced server-side. `upsell` shows
   * a lock naming the plans that include it, instead of a bare dash.
   */
  | { kind: 'flag'; key: string; label: string; hint?: string; upsell?: boolean }
  /** Present on every plan. */
  | { kind: 'always'; label: string; hint?: string }
  /** Present where the flag allows, and billed per message on top. */
  | { kind: 'usage'; key: string; label: string; hint?: string };

export interface PlanSection {
  heading: string;
  blurb?: string;
  rows: PlanRow[];
}

export const PLAN_SECTIONS: PlanSection[] = [
  {
    heading: 'Business limits',
    blurb: 'The numbers that decide which plan you need.',
    rows: [
      { kind: 'limit', key: 'maxStores', label: 'Branches' },
      { kind: 'limit', key: 'maxStaff', label: 'Staff accounts', hint: 'The owner account is free and never counts.' },
      { kind: 'limit', key: 'maxProducts', label: 'Products' },
      { kind: 'limit', key: 'maxMonthlySales', label: 'Sales per month', hint: 'Resets on the 1st. Cancelled sales are not counted.' },
      { kind: 'limit', key: 'maxCustomers', label: 'Customer profiles' },
    ],
  },
  {
    heading: 'Storage',
    blurb: 'Product photos and receipt logos.',
    rows: [
      { kind: 'limit', key: 'maxStorageBytes', label: 'File storage', format: 'bytes' },
      {
        kind: 'flag',
        key: 'imageOptimization',
        label: 'Automatic Image Optimization & WebP Conversion',
        hint: 'Large photos are resized, compressed and converted to WebP on upload, so high-resolution images cost a fraction of your quota.',
      },
    ],
  },
  {
    heading: 'Point of sale',
    blurb: 'Included in full on every plan, including the trial.',
    rows: [
      { kind: 'always', label: 'Touch and keyboard till' },
      { kind: 'always', label: 'Barcode scanning' },
      { kind: 'always', label: 'Line and cart discounts' },
      { kind: 'always', label: 'Split payment and change due' },
      { kind: 'always', label: 'Thermal receipt printing' },
      { kind: 'always', label: 'Returns and refunds' },
      { kind: 'always', label: 'Sales history and reprints' },
    ],
  },
  {
    heading: 'Products and inventory',
    rows: [
      { kind: 'always', label: 'Products, variants and SKUs' },
      { kind: 'always', label: 'Barcode generation' },
      { kind: 'always', label: 'Categories' },
      { kind: 'always', label: 'Product photos' },
      { kind: 'always', label: 'Stock levels per branch' },
      { kind: 'always', label: 'Low-stock alerts' },
      { kind: 'flag', key: 'inventoryLedger', label: 'Full inventory ledger', hint: 'Every movement, with who and why.' },
    ],
  },
  {
    heading: 'Multiple branches',
    rows: [
      { kind: 'flag', key: 'multiStore', label: 'Run more than one branch' },
      { kind: 'flag', key: 'multiStore', label: 'Shared product catalogue' },
      { kind: 'flag', key: 'multiStore', label: 'Shared customer database' },
      { kind: 'flag', key: 'multiStore', label: 'Per-branch stock, sales and pricing' },
      { kind: 'flag', key: 'multiStore', label: 'Branch comparison reporting' },
    ],
  },
  {
    heading: 'Staff and permissions',
    rows: [
      { kind: 'always', label: 'Staff accounts' },
      { kind: 'always', label: 'Built-in manager and cashier roles' },
      { kind: 'always', label: 'Per-branch staff assignment' },
      { kind: 'flag', key: 'customRoles', label: 'Custom roles' },
      { kind: 'flag', key: 'customRoles', label: 'Per-permission control' },
    ],
  },
  {
    heading: 'Customers',
    rows: [
      { kind: 'flag', key: 'customerManagement', label: 'Customer profiles' },
      { kind: 'flag', key: 'customerManagement', label: 'Purchase history' },
      { kind: 'flag', key: 'customerManagement', label: 'Customer wallet and dues' },
      { kind: 'flag', key: 'advancedReports', label: 'Customer spending analysis' },
    ],
  },
  {
    heading: 'Dashboard and analytics',
    rows: [
      // `salesReports` is the Dashboard's flag, and it is on every plan.
      { kind: 'flag', key: 'salesReports', label: 'Dashboard', hint: 'Sales, orders, stock value, recent sales and low stock at a glance.' },
      { kind: 'flag', key: 'salesReports', label: 'Sales trend and top sellers' },
      {
        kind: 'flag',
        key: 'advancedReports',
        label: 'Advanced Analytics',
        hint: 'Every analysis below, on one screen.',
        upsell: true,
      },
      { kind: 'flag', key: 'advancedReports', label: 'Profit, margin and cost of goods' },
      { kind: 'flag', key: 'advancedReports', label: 'Period-over-period comparison' },
      { kind: 'flag', key: 'advancedReports', label: 'Product and variant performance' },
      { kind: 'flag', key: 'advancedReports', label: 'Payment, return and staff analysis' },
      { kind: 'flag', key: 'advancedReports', label: 'Inventory valuation' },
      { kind: 'flag', key: 'multiStore', label: 'Branch performance comparison' },
    ],
  },
  {
    heading: 'Marketing',
    blurb: 'Available on paid tiers. Messages are charged per send from your wallet.',
    rows: [
      { kind: 'usage', key: 'smsMarketing', label: 'SMS campaigns' },
      { kind: 'usage', key: 'emailMarketing', label: 'Email campaigns' },
      { kind: 'flag', key: 'smsMarketing', label: 'Campaign history and delivery status' },
    ],
  },
  {
    heading: 'Support',
    rows: [
      { kind: 'always', label: 'Email support' },
      { kind: 'flag', key: 'prioritySupport', label: 'Priority support' },
    ],
  },
];

/**
 * Short names for the plan feature flags.
 *
 * The subscription page lists a plan's features as badges and the pricing page
 * groups them into rows; both name them from here, so a flag cannot be called
 * two different things in two places.
 */
export const FEATURE_LABELS: Record<string, string> = {
  salesReports: 'Sales reports',
  advancedReports: 'Advanced Analytics',
  customerManagement: 'Customer management',
  inventoryLedger: 'Inventory ledger',
  multiStore: 'Multiple branches',
  customRoles: 'Custom roles',
  exportData: 'Data export',
  prioritySupport: 'Priority support',
  smsMarketing: 'SMS marketing',
  emailMarketing: 'Email marketing',
  imageOptimization: 'Automatic image optimization',
};

/** Every feature key the catalogue references, deduplicated. */
export const CATALOG_FEATURE_KEYS = [
  ...new Set(
    PLAN_SECTIONS.flatMap((section) =>
      section.rows.flatMap((row) => (row.kind === 'flag' || row.kind === 'usage' ? [row.key] : [])),
    ),
  ),
];


/**
 * "Showroom & Brand": the plan families that include a feature, read from the
 * plans themselves so the wording follows the backend configuration.
 */
export function availableOn(plans: SubscriptionPlan[], key: string): string {
  const names = [
    ...new Set(
      [...plans]
        .filter((plan) => plan.features[key])
        .sort((a, b) => a.tier - b.tier)
        .map((plan) => plan.name.replace(/ Annual$/, '')),
    ),
  ];
  if (names.length <= 1) return names[0] ?? 'higher plans';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** `-1` is the server's sentinel for "no limit". */
export function formatLimit(value: number | undefined, format?: 'bytes'): string {
  if (value === undefined) return '—';
  if (value === -1) return 'Unlimited';
  return format === 'bytes' ? formatBytes(value) : value.toLocaleString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * What a customer gains by moving up one tier, derived from the plans
 * themselves so it cannot drift out of date.
 *
 * Both halves matter. Comparing only feature flags made "Showroom to Brand"
 * read as "adds support", when the actual difference is five times the
 * branches and no ceiling on products, staff, customers or sales.
 */
export function upgradeHighlights(from: SubscriptionPlan, to: SubscriptionPlan): string[] {
  const highlights: string[] = [];

  // ---- bigger numbers ----------------------------------------------------
  const UNLIMITED_LABELS: Record<string, string> = {
    maxProducts: 'products',
    maxStaff: 'staff',
    maxCustomers: 'customers',
    maxMonthlySales: 'monthly sales',
  };

  const becameUnlimited = Object.entries(UNLIMITED_LABELS)
    .filter(([key]) => from.limits[key] !== -1 && to.limits[key] === -1)
    .map(([, label]) => label);

  if (becameUnlimited.length > 0) {
    highlights.push(`unlimited ${joinWords(becameUnlimited)}`);
  }

  // Only the branch count is repeated here. The cards directly above already
  // show all six limits per plan, so restating each one turns the callout into
  // a wall of text nobody reads.
  const beforeStores = from.limits.maxStores;
  const afterStores = to.limits.maxStores;
  if (beforeStores !== undefined && afterStores !== undefined && beforeStores !== -1 && afterStores > beforeStores) {
    highlights.push(`${formatLimit(afterStores)} branches instead of ${formatLimit(beforeStores)}`);
  }

  const beforeStorage = from.limits.maxStorageBytes;
  const afterStorage = to.limits.maxStorageBytes;
  if (beforeStorage !== undefined && afterStorage !== undefined && beforeStorage !== -1 && afterStorage > beforeStorage) {
    highlights.push(`${formatLimit(afterStorage, 'bytes')} storage`);
  }

  // ---- new capabilities ---------------------------------------------------
  const gained = CATALOG_FEATURE_KEYS.filter((key) => !from.features[key] && to.features[key]);
  for (const key of gained) {
    const phrase = UPGRADE_PHRASES[key];
    if (!phrase) continue;
    // "multiple branches" says nothing the branch count above has not already
    // said better.
    if (key === 'multiStore' && highlights.some((line) => line.includes('branches'))) continue;
    highlights.push(phrase);
  }

  return highlights;
}

/**
 * How each feature reads in an upgrade sentence.
 *
 * Written out rather than derived from section headings: a flag can appear in
 * several sections, and picking one automatically produced labels like
 * "customers" for what is really advanced analytics.
 */
const UPGRADE_PHRASES: Record<string, string> = {
  multiStore: 'multiple branches',
  customRoles: 'custom roles and permissions',
  advancedReports: 'Advanced Analytics',
  smsMarketing: 'SMS marketing',
  emailMarketing: 'email marketing',
  imageOptimization: 'automatic image optimization and WebP conversion',
  prioritySupport: 'priority support',
  salesReports: 'sales reports',
  customerManagement: 'customer profiles',
  inventoryLedger: 'inventory ledger',
};

function joinWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * An itemised list of what moving from one plan to another adds.
 *
 * The pricing page wants a one-line summary; a customer on the billing page
 * deciding whether to pay wants the specifics, so this returns every limit that
 * rises and every feature that switches on. Derived from the plan objects, so
 * it always matches what the backend will actually grant.
 */
export function upgradeGains(from: SubscriptionPlan, to: SubscriptionPlan): string[] {
  const gains: string[] = [];

  const LIMIT_NOUNS: { key: string; noun: string; format?: 'bytes' }[] = [
    { key: 'maxStores', noun: 'stores' },
    { key: 'maxStaff', noun: 'staff accounts' },
    { key: 'maxProducts', noun: 'products' },
    { key: 'maxMonthlySales', noun: 'monthly transactions' },
    { key: 'maxCustomers', noun: 'customers' },
    { key: 'maxStorageBytes', noun: 'storage', format: 'bytes' },
  ];

  for (const { key, noun, format } of LIMIT_NOUNS) {
    const before = from.limits[key];
    const after = to.limits[key];
    if (before === undefined || after === undefined) continue;
    if (before === after) continue;
    // Already unlimited cannot improve.
    if (before === -1) continue;

    gains.push(
      after === -1 ? `Unlimited ${noun}` : `${formatLimit(after, format)} ${noun} (up from ${formatLimit(before, format)})`,
    );
  }

  for (const key of CATALOG_FEATURE_KEYS) {
    if (!from.features[key] && to.features[key]) {
      gains.push(FEATURE_LABELS[key] ?? key);
    }
  }

  return gains;
}
