import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { TRIAL_LENGTH_DAYS } from '../services/subscription/trialPolicy';

/**
 * Plan definitions live in the database. These are seed VALUES, not application
 * constants - a platform admin can change any price or limit at runtime without
 * touching the codebase.
 *
 * Prices are in minor units (poisha): 99_000 = BDT 990.00
 *
 * Only ONE plan carries a trial. `trialDays > 0` is what marks a plan as
 * trial-eligible, so setting it to 0 on the paid tiers is not cosmetic - it is
 * how the server decides nobody can start a free Professional or Enterprise.
 *
 * Plan CODES are permanent identifiers (`showroom-*` is Professional, `brand-*`
 * is Enterprise). Existing subscriptions, upgrade requests and payments point at
 * them, so only the display names changed - never the codes.
 *
 * Existing databases pick up name/price changes with `npm run migrate`
 * (syncPlanPackages), which touches nothing but labels and prices.
 */
const MB = 1024 ** 2;
const GB = 1024 ** 3;

export const PLAN_SEEDS = [
  {
    code: 'starter-store-monthly',
    name: 'Starter',
    description: 'For a single shop finding its feet. Everything you need to ring up sales.',
    interval: 'monthly' as const,
    priceMinor: 99_000,
    currency: 'BDT',
    trialDays: TRIAL_LENGTH_DAYS,
    sortOrder: 1,
    tier: 1,
    features: {
      salesReports: true,
      advancedReports: false,
      customerManagement: true,
      inventoryLedger: true,
      multiStore: false,
      customRoles: false,
      exportData: false,
      prioritySupport: false,
      // Marketing is a growth feature; Starter upgrades for it.
      smsMarketing: false,
      emailMarketing: false,
      imageOptimization: false,
      loyaltyProgram: false,
    },
    // Starter is a single-shop plan.
    limits: {
      maxStaff: 2,
      maxProducts: 300,
      maxStores: 1,
      maxMonthlySales: 2_500,
      maxCustomers: 500,
      maxStorageBytes: MB * 500,
    },
  },
  {
    code: 'showroom-monthly',
    // Internal code stays `showroom-*`; sold as Professional.
    name: 'Professional',
    description: 'For a growing store with a full floor team and Advanced Analytics.',
    interval: 'monthly' as const,
    priceMinor: 199_000,
    currency: 'BDT',
    trialDays: 0,
    sortOrder: 2,
    tier: 2,
    features: {
      salesReports: true,
      advancedReports: true,
      customerManagement: true,
      inventoryLedger: true,
      // Advertised only because maxStores > 1 actually enforces it.
      multiStore: true,
      customRoles: true,
      exportData: true,
      prioritySupport: false,
      smsMarketing: true,
      emailMarketing: true,
      imageOptimization: false,
      loyaltyProgram: true,
    },
    limits: {
      maxStaff: 6,
      maxProducts: 3_000,
      maxStores: 2,
      maxMonthlySales: 30_000,
      maxCustomers: 10_000,
      maxStorageBytes: GB * 1,
    },
  },
  {
    code: 'brand-monthly',
    // Internal code stays `brand-*`; sold as Enterprise.
    name: 'Enterprise',
    description: 'For multi-branch retailers who need everything, without limits.',
    interval: 'monthly' as const,
    priceMinor: 299_000,
    currency: 'BDT',
    trialDays: 0,
    sortOrder: 3,
    tier: 3,
    features: {
      salesReports: true,
      advancedReports: true,
      customerManagement: true,
      inventoryLedger: true,
      multiStore: true,
      customRoles: true,
      exportData: true,
      prioritySupport: true,
      smsMarketing: true,
      emailMarketing: true,
      // Brand only: uploads are resized and stored as WebP.
      imageOptimization: true,
      loyaltyProgram: true,
    },
    limits: {
      maxStaff: -1,
      maxProducts: -1,
      maxStores: 10,
      maxMonthlySales: -1,
      maxCustomers: -1,
      // Storage is the one thing Brand is not unlimited on - bytes cost money.
      // Brand's automatic WebP optimisation makes this go much further.
      maxStorageBytes: GB * 2,
    },
  },
];

/**
 * Annual plans mirror the monthly tiers at exactly ten months' price (two
 * months free). Derived here, never written out, so the two cannot disagree.
 */
const ANNUAL_SEEDS = PLAN_SEEDS.map((plan) => ({
  ...plan,
  // The trial is a monthly offer. An annual variant inheriting it would make a
  // second plan trial-eligible, which is exactly what the rule forbids.
  trialDays: 0,
  code: plan.code.replace('-monthly', '-annual'),
  name: `${plan.name} Annual`,
  description: `${plan.description} Billed yearly - two months free.`,
  interval: 'yearly' as const,
  priceMinor: plan.priceMinor * 10,
  sortOrder: plan.sortOrder + 10,
}));

/** Every sellable plan: the three monthly tiers and their annual twins. */
export const ALL_PLAN_SEEDS = [...PLAN_SEEDS, ...ANNUAL_SEEDS];

export async function seedPlans(): Promise<number> {
  const all = ALL_PLAN_SEEDS;

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
