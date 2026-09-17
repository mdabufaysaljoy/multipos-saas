import type { Types } from 'mongoose';
import { CatalogPlanModel, type CatalogPlanDoc, type CatalogPlanStatus } from '../../models/CatalogPlan';
import { PlanPriceModel, type BillingCycle, type PlanPriceDoc } from '../../models/PlanPrice';
import { PosProductModel, type PosProductDoc } from '../../models/PosProduct';
import { ApiError } from '../../utils/ApiError';
import { minorToDecimalString } from '../payment/money';
import { ensureDefaultPosProducts } from '../posCatalog/posCatalog.service';

type PlanRecord = CatalogPlanDoc & { _id: Types.ObjectId };
type PriceRecord = PlanPriceDoc & { _id: Types.ObjectId };
type ProductRecord = PosProductDoc & { _id: Types.ObjectId };

// ------------------------------------------------------------------ the rules

/** Annual billing: ten months paid, two months free. */
export const ANNUAL_PAID_MONTHS = 10;
export const ANNUAL_FREE_MONTHS = 2;
export const annualAmountFromMonthly = (monthlyMinor: number): number => monthlyMinor * ANNUAL_PAID_MONTHS;

/** Default prices start here, so any real moment is after them. */
export const DEFAULT_PRICE_EPOCH = new Date('2020-01-01T00:00:00.000Z');
/** Clock skew tolerated when an admin schedules a price "now". */
const SCHEDULE_SKEW_MS = 60_000;
const DEFAULT_CURRENCY = 'BDT';

/**
 * The catalog every deployment starts with, and the default monthly price of
 * each plan for every POS product. Annual prices are DERIVED from the monthly
 * price here, never written out, so the two cannot disagree.
 *
 * `legacy` maps each plan onto the per-interval plan SKUs that existing
 * subscriptions, requests and payments already reference - those codes are
 * permanent and are not renamed.
 */
export const DEFAULT_CATALOG_PLANS = [
  {
    code: 'starter',
    displayName: 'Starter',
    description: 'For a single shop finding its feet. Everything you need to ring up sales.',
    sortOrder: 1,
    tier: 1,
    monthlyMinor: 99_000,
    legacy: { monthly: 'starter-store-monthly', annual: 'starter-store-annual' },
  },
  {
    code: 'professional',
    displayName: 'Professional',
    description: 'For a growing store with a full floor team and Advanced Analytics.',
    sortOrder: 2,
    tier: 2,
    monthlyMinor: 199_000,
    legacy: { monthly: 'showroom-monthly', annual: 'showroom-annual' },
  },
  {
    code: 'enterprise',
    displayName: 'Enterprise',
    description: 'For multi-branch businesses who need everything, without limits.',
    sortOrder: 3,
    tier: 3,
    monthlyMinor: 299_000,
    legacy: { monthly: 'brand-monthly', annual: 'brand-annual' },
  },
] as const;

const isDuplicateKey = (error: unknown) =>
  (error as { code?: number })?.code === 11000 ||
  (((error as { writeErrors?: { code?: number }[] })?.writeErrors ?? []).length > 0 &&
    ((error as { writeErrors: { code?: number }[] }).writeErrors.every((entry) => entry.code === 11000)));

// ----------------------------------------------------------------- seeding

/**
 * Creates any missing catalog plan and any missing default price, for every POS
 * product. Keyed on (product, plan, cycle, DEFAULT_PRICE_EPOCH) with
 * `$setOnInsert`, so it NEVER changes a price an admin set or deactivated, and
 * a POS product added later receives the default prices. Safe to run
 * concurrently and repeatedly.
 */
export async function ensurePricingCatalog(): Promise<{ plansCreated: number; pricesCreated: number }> {
  await ensureDefaultPosProducts();

  let plansCreated = 0;
  try {
    const result = await CatalogPlanModel.bulkWrite(
      DEFAULT_CATALOG_PLANS.map((plan) => ({
        updateOne: {
          filter: { code: plan.code },
          update: {
            $setOnInsert: {
              code: plan.code,
              displayName: plan.displayName,
              description: plan.description,
              status: 'active' as CatalogPlanStatus,
              sortOrder: plan.sortOrder,
              tier: plan.tier,
              metadata: { legacyPlanCodes: plan.legacy, highlights: [] },
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    plansCreated = result.upsertedCount;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }

  const [plans, products] = await Promise.all([
    CatalogPlanModel.find({ code: { $in: DEFAULT_CATALOG_PLANS.map((plan) => plan.code) } }).lean<PlanRecord[]>(),
    PosProductModel.find().lean<ProductRecord[]>(),
  ]);

  const operations = products.flatMap((product) =>
    DEFAULT_CATALOG_PLANS.flatMap((definition) => {
      const plan = plans.find((entry) => entry.code === definition.code);
      if (!plan) return [];
      return (['monthly', 'annual'] as const).map((billingCycle) => ({
        updateOne: {
          filter: { posProductId: product._id, planId: plan._id, billingCycle, effectiveFrom: DEFAULT_PRICE_EPOCH },
          update: {
            $setOnInsert: {
              posProductId: product._id,
              posProductCode: product.code,
              planId: plan._id,
              planCode: plan.code,
              billingCycle,
              amountMinor: billingCycle === 'monthly' ? definition.monthlyMinor : annualAmountFromMonthly(definition.monthlyMinor),
              currency: DEFAULT_CURRENCY,
              active: true,
              effectiveFrom: DEFAULT_PRICE_EPOCH,
              effectiveTo: null,
              note: 'Default price',
              createdBy: null,
              createdByNameSnapshot: 'system',
            },
          },
          upsert: true,
        },
      }));
    }),
  );

  let pricesCreated = 0;
  if (operations.length > 0) {
    try {
      pricesCreated = (await PlanPriceModel.bulkWrite(operations, { ordered: false })).upsertedCount;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }
  return { plansCreated, pricesCreated };
}

/**
 * Seeding runs at most once a minute per process on the request path (and at
 * startup), so a POS product an admin adds picks up default prices quickly
 * without every public request writing to the database.
 */
let ensuredAt = 0;
async function ensureRecently() {
  if (Date.now() - ensuredAt < 60_000) return;
  await ensurePricingCatalog();
  ensuredAt = Date.now();
}
/** Tests only: forget that seeding ran. */
export const resetPricingCatalogCache = () => {
  ensuredAt = 0;
};

// ---------------------------------------------------------------- resolution

export interface PriceView {
  priceId: Types.ObjectId;
  billingCycle: BillingCycle;
  currency: string;
  amountMinor: number;
  /** "990.00" - exact, from integer minor units. */
  amount: string;
  periodMonths: number;
  paidMonths: number;
  freeMonths: number;
  /** Annual only: the amount spread over 12 months, rounded down. */
  monthlyEquivalentMinor: number;
  /** Annual only: 12 × the monthly price in effect − the annual price (never negative). */
  savingsMinor: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** The row in effect at `at` for a combination, active or not. */
function effectiveRow(posProductId: Types.ObjectId, planId: Types.ObjectId, billingCycle: BillingCycle, at: Date) {
  return PlanPriceModel.findOne({
    posProductId,
    planId,
    billingCycle,
    effectiveFrom: { $lte: at },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }],
  })
    .sort({ effectiveFrom: -1 })
    .lean<PriceRecord>();
}

function viewOf(price: PriceRecord, monthly: PriceRecord | null): PriceView {
  const annual = price.billingCycle === 'annual';
  return {
    priceId: price._id,
    billingCycle: price.billingCycle,
    currency: price.currency,
    amountMinor: price.amountMinor,
    amount: minorToDecimalString(price.amountMinor),
    periodMonths: annual ? 12 : 1,
    paidMonths: annual ? ANNUAL_PAID_MONTHS : 1,
    freeMonths: annual ? ANNUAL_FREE_MONTHS : 0,
    monthlyEquivalentMinor: annual ? Math.floor(price.amountMinor / 12) : price.amountMinor,
    savingsMinor:
      annual && monthly && monthly.currency === price.currency ? Math.max(0, monthly.amountMinor * 12 - price.amountMinor) : 0,
    effectiveFrom: price.effectiveFrom,
    effectiveTo: price.effectiveTo,
  };
}

/**
 * Unknown and inactive POS products look the same from outside: no pricing.
 * `allowInactive` is for EXISTING workspaces: deactivating a POS type stops
 * new workspaces, not the ones already running on it, which must still be able
 * to buy and renew.
 */
async function sellablePosProduct(code: string, allowInactive = false) {
  const product = await PosProductModel.findOne({ code }).lean<ProductRecord>();
  if (!product || (product.status !== 'active' && !allowInactive)) throw ApiError.notFound('Pricing is not available for this POS type');
  return product;
}

export interface QuoteInput {
  posType: string;
  plan: string;
  billingCycle: BillingCycle;
}

/**
 * The pricing engine. The ONLY place an amount for a plan is decided: callers
 * name a POS type, a plan and a billing cycle, and get back the server's price.
 */
class PricingService {
  /** Every active plan with its monthly and annual price for one POS type. */
  async catalog(posType: string, at = new Date()) {
    await ensureRecently();
    const product = await sellablePosProduct(posType);
    const plans = await CatalogPlanModel.find({ status: 'active' }).sort({ sortOrder: 1, tier: 1 }).lean<PlanRecord[]>();

    const entries = await Promise.all(
      plans.map(async (plan) => {
        const [monthly, annual] = await Promise.all([
          effectiveRow(product._id, plan._id, 'monthly', at),
          effectiveRow(product._id, plan._id, 'annual', at),
        ]);
        const liveMonthly = monthly?.active ? monthly : null;
        return {
          code: plan.code,
          displayName: plan.displayName,
          description: plan.description,
          tier: plan.tier,
          highlights: plan.metadata?.highlights ?? [],
          monthly: liveMonthly ? viewOf(liveMonthly, liveMonthly) : null,
          annual: annual?.active ? viewOf(annual, liveMonthly) : null,
        };
      }),
    );

    return {
      posType: product.code,
      posProductName: product.name,
      // A plan with no purchasable price on either cycle is not offered.
      plans: entries.filter((entry) => entry.monthly || entry.annual),
    };
  }

  /**
   * The amount for one plan on one cycle for one POS type, right now.
   *   unknown or inactive POS type  -> 404
   *   unknown plan                  -> 404
   *   inactive plan                 -> 409
   *   no price in effect, or inactive price -> 409
   */
  async quote(input: QuoteInput, at = new Date(), options: { allowInactivePosProduct?: boolean } = {}) {
    await ensureRecently();
    const product = await sellablePosProduct(input.posType, options.allowInactivePosProduct);
    const plan = await CatalogPlanModel.findOne({ code: input.plan }).lean<PlanRecord>();
    if (!plan) throw ApiError.notFound('Unknown plan');
    if (plan.status !== 'active') throw ApiError.conflict(`${plan.displayName} is not available`, { reason: 'PLAN_INACTIVE' });

    const price = await effectiveRow(product._id, plan._id, input.billingCycle, at);
    if (!price || !price.active) {
      throw ApiError.conflict(`${plan.displayName} is not available on ${input.billingCycle} billing for ${product.name}`, {
        reason: 'PRICE_UNAVAILABLE',
      });
    }
    const monthly = input.billingCycle === 'annual' ? await effectiveRow(product._id, plan._id, 'monthly', at) : price;

    return {
      posType: product.code,
      posProductName: product.name,
      plan: { code: plan.code, displayName: plan.displayName, description: plan.description, tier: plan.tier },
      ...viewOf(price, monthly?.active ? monthly : null),
    };
  }

  // ------------------------------------------------------------ administration

  async listPlans() {
    await ensureRecently();
    return CatalogPlanModel.find().sort({ sortOrder: 1, tier: 1 }).lean<PlanRecord[]>();
  }

  async updatePlan(code: string, input: Partial<Pick<CatalogPlanDoc, 'displayName' | 'description' | 'status' | 'sortOrder'>>) {
    await ensureRecently();
    const before = await CatalogPlanModel.findOne({ code }).lean<PlanRecord>();
    if (!before) throw ApiError.notFound('Unknown plan');
    const after = await CatalogPlanModel.findOneAndUpdate({ code }, { $set: input }, { new: true, runValidators: true }).lean<PlanRecord>();
    if (!after) throw ApiError.notFound('Unknown plan');
    return { before, after };
  }

  /** Every price version, newest first within each combination, with its state now. */
  async listPrices(filter: { posType?: string; plan?: string; billingCycle?: BillingCycle }, at = new Date()) {
    await ensureRecently();
    const query: Record<string, unknown> = {};
    if (filter.posType) query.posProductCode = filter.posType;
    if (filter.plan) query.planCode = filter.plan;
    if (filter.billingCycle) query.billingCycle = filter.billingCycle;
    const rows = await PlanPriceModel.find(query).sort({ posProductCode: 1, planCode: 1, billingCycle: 1, effectiveFrom: -1 }).limit(1000).lean<PriceRecord[]>();
    return rows.map((row) => ({
      ...row,
      amount: minorToDecimalString(row.amountMinor),
      state: row.effectiveFrom > at ? 'scheduled' : row.effectiveTo && row.effectiveTo <= at ? 'ended' : 'current',
    }));
  }

  /**
   * Schedules a new price version. It starts now or later - never in the past,
   * because a price already charged must stay the price it was. The version it
   * replaces is closed at the new start. Refused if a later version is already
   * scheduled (cancel that one first), so versions never interleave.
   */
  async schedulePrice(
    input: QuoteInput & { amountMinor: number; currency: string; effectiveFrom?: Date; note: string },
    actor: { id: Types.ObjectId | null; name: string },
  ) {
    await ensureRecently();
    const product = await PosProductModel.findOne({ code: input.posType }).lean<ProductRecord>();
    if (!product) throw ApiError.notFound('Unknown POS type');
    const plan = await CatalogPlanModel.findOne({ code: input.plan }).lean<PlanRecord>();
    if (!plan) throw ApiError.notFound('Unknown plan');
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) throw ApiError.badRequest('The amount must be a whole number of minor units');

    const now = new Date();
    const effectiveFrom = input.effectiveFrom ?? now;
    if (effectiveFrom.getTime() < now.getTime() - SCHEDULE_SKEW_MS) {
      throw ApiError.badRequest('A price cannot start in the past. Prices already charged are never rewritten.');
    }

    const combination = { posProductId: product._id, planId: plan._id, billingCycle: input.billingCycle };
    if (await PlanPriceModel.exists({ ...combination, effectiveFrom: { $gt: effectiveFrom } })) {
      throw ApiError.conflict('A later price is already scheduled for this plan and cycle. Cancel it first.');
    }

    let created: PriceRecord;
    try {
      created = (
        await PlanPriceModel.create({
          ...combination,
          posProductCode: product.code,
          planCode: plan.code,
          amountMinor: input.amountMinor,
          currency: input.currency,
          active: true,
          effectiveFrom,
          effectiveTo: null,
          note: input.note,
          createdBy: actor.id,
          createdByNameSnapshot: actor.name,
        })
      ).toObject() as PriceRecord;
    } catch (error) {
      if (isDuplicateKey(error)) throw ApiError.conflict('A price already starts at that moment for this plan and cycle');
      throw error;
    }

    // Close whatever would otherwise still be in effect after the new start.
    await PlanPriceModel.updateMany(
      { ...combination, _id: { $ne: created._id }, effectiveFrom: { $lt: effectiveFrom }, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: effectiveFrom } }] },
      { $set: { effectiveTo: effectiveFrom } },
    );
    return { ...created, amount: minorToDecimalString(created.amountMinor) };
  }

  async setPriceActive(id: Types.ObjectId, active: boolean) {
    const before = await PlanPriceModel.findById(id).lean<PriceRecord>();
    if (!before) throw ApiError.notFound('Price not found');
    const after = await PlanPriceModel.findByIdAndUpdate(id, { $set: { active } }, { new: true }).lean<PriceRecord>();
    if (!after) throw ApiError.notFound('Price not found');
    return { before, after };
  }

  /** Removes a version that has NOT taken effect yet and reopens the one it would have replaced. */
  async cancelScheduledPrice(id: Types.ObjectId) {
    const row = await PlanPriceModel.findById(id).lean<PriceRecord>();
    if (!row) throw ApiError.notFound('Price not found');
    const deleted = await PlanPriceModel.findOneAndDelete({ _id: id, effectiveFrom: { $gt: new Date() } }).lean<PriceRecord>();
    if (!deleted) throw ApiError.conflict('This price has already taken effect. Deactivate it instead.');
    await PlanPriceModel.updateMany(
      { posProductId: row.posProductId, planId: row.planId, billingCycle: row.billingCycle, effectiveTo: row.effectiveFrom },
      { $set: { effectiveTo: null } },
    );
    return deleted;
  }

  // ------------------------------------------------------------ compatibility

  /** `showroom-annual` -> { plan: 'professional', billingCycle: 'annual' }. */
  async catalogPlanForLegacyCode(legacyCode: string): Promise<{ plan: string; billingCycle: BillingCycle } | null> {
    await ensureRecently();
    const plan = await CatalogPlanModel.findOne({
      $or: [{ 'metadata.legacyPlanCodes.monthly': legacyCode }, { 'metadata.legacyPlanCodes.annual': legacyCode }],
    }).lean<PlanRecord>();
    if (!plan) return null;
    return { plan: plan.code, billingCycle: plan.metadata.legacyPlanCodes.monthly === legacyCode ? 'monthly' : 'annual' };
  }

  /** { plan: 'professional', billingCycle: 'monthly' } -> `showroom-monthly`. */
  async legacyCodeFor(planCode: string, billingCycle: BillingCycle): Promise<string | null> {
    await ensureRecently();
    const plan = await CatalogPlanModel.findOne({ code: planCode }).lean<PlanRecord>();
    return plan?.metadata?.legacyPlanCodes?.[billingCycle] ?? null;
  }
}

export const pricingService = new PricingService();
