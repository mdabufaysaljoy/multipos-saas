import { SubscriptionPlanModel } from '../models/SubscriptionPlan';

/**
 * Plan definitions live in the database. These are seed VALUES, not application
 * constants - a platform admin can change any price or limit at runtime without
 * touching the codebase.
 *
 * Prices are in minor units (poisha): 99_000 = BDT 990.00
 */
export const PLAN_SEEDS = [
  {
    code: 'starter-store-monthly',
    name: 'Starter Store',
    description: 'For a single shop finding its feet. Everything you need to ring up sales.',
    interval: 'monthly' as const,
    priceMinor: 99_000,
    currency: 'BDT',
    trialDays: 14,
    sortOrder: 1,
    features: {
      salesReports: true,
      advancedReports: false,
      customerManagement: true,
      inventoryLedger: true,
      multiStore: false,
      customRoles: false,
      exportData: false,
      prioritySupport: false,
    },
    limits: { maxStaff: 2, maxProducts: 300, maxStores: 1, maxMonthlySales: -1 },
  },
  {
    code: 'showroom-monthly',
    name: 'Showroom',
    description: 'For a growing showroom with a full floor team and deeper reporting.',
    interval: 'monthly' as const,
    priceMinor: 249_000,
    currency: 'BDT',
    trialDays: 14,
    sortOrder: 2,
    features: {
      salesReports: true,
      advancedReports: true,
      customerManagement: true,
      inventoryLedger: true,
      multiStore: false,
      customRoles: true,
      exportData: true,
      prioritySupport: false,
    },
    limits: { maxStaff: 10, maxProducts: 3_000, maxStores: 1, maxMonthlySales: -1 },
  },
  {
    code: 'brand-monthly',
    name: 'Brand',
    description: 'For multi-branch retailers who need everything, without limits.',
    interval: 'monthly' as const,
    priceMinor: 599_000,
    currency: 'BDT',
    trialDays: 14,
    sortOrder: 3,
    features: {
      salesReports: true,
      advancedReports: true,
      customerManagement: true,
      inventoryLedger: true,
      multiStore: true,
      customRoles: true,
      exportData: true,
      prioritySupport: true,
    },
    limits: { maxStaff: -1, maxProducts: -1, maxStores: 10, maxMonthlySales: -1 },
  },
];

/** Annual plans mirror the monthly tiers at roughly ten months' price. */
const ANNUAL_SEEDS = PLAN_SEEDS.map((plan) => ({
  ...plan,
  code: plan.code.replace('-monthly', '-annual'),
  name: `${plan.name} Annual`,
  description: `${plan.description} Billed yearly - two months free.`,
  interval: 'yearly' as const,
  priceMinor: plan.priceMinor * 10,
  sortOrder: plan.sortOrder + 10,
}));

export async function seedPlans(): Promise<number> {
  const all = [...PLAN_SEEDS, ...ANNUAL_SEEDS];

  for (const plan of all) {
    // Upsert on code so re-running the seed updates rather than duplicates.
    await SubscriptionPlanModel.updateOne(
      { code: plan.code },
      { $set: { ...plan, isActive: true, isPublic: true } },
      { upsert: true },
    );
  }

  return all.length;
}
