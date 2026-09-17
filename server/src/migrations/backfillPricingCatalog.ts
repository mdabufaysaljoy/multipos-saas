/**
 * Introduces the universal plan catalog and pricing engine.
 *
 *   - Creates the catalog plans (starter, professional, enterprise) and the
 *     default price of each plan on each billing cycle for every POS product.
 *     Existing plans and prices are never overwritten.
 *   - Reports how the existing per-interval plan SKUs (`starter-store-*`,
 *     `showroom-*`, `brand-*`) map onto the catalog, and whether each SKU's
 *     current price agrees with the Clothing price in the engine.
 *
 * NOTHING existing is changed: subscription plans, subscriptions, upgrade
 * requests and payments keep their codes and amounts exactly. A price mismatch
 * is reported for a platform admin to resolve, not corrected silently.
 *
 * Idempotent. Run with:  npm run migrate:pricing-catalog -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { DEFAULT_POS_VERTICAL } from '../config/verticals';
import { logger } from '../utils/logger';
import { CatalogPlanModel } from '../models/CatalogPlan';
import { PlanPriceModel } from '../models/PlanPrice';
import { SubscriptionPlanModel } from '../models/SubscriptionPlan';
import { ensurePricingCatalog, pricingService, resetPricingCatalogCache } from '../services/pricing/pricing.service';

export interface PricingCatalogReport {
  plansCreated: number;
  pricesCreated: number;
  mapped: { sku: string; plan: string; billingCycle: string; skuPriceMinor: number; enginePriceMinor: number | null; matches: boolean }[];
  unmapped: string[];
}

export async function backfillPricingCatalog(): Promise<PricingCatalogReport> {
  resetPricingCatalogCache();
  const { plansCreated, pricesCreated } = await ensurePricingCatalog();

  const skus = await SubscriptionPlanModel.find().select('code priceMinor posProductCode').lean();
  const mapped: PricingCatalogReport['mapped'] = [];
  const unmapped: string[] = [];

  for (const sku of skus) {
    const target = await pricingService.catalogPlanForLegacyCode(sku.code);
    if (!target) {
      unmapped.push(sku.code);
      continue;
    }
    const plan = await CatalogPlanModel.findOne({ code: target.plan }).select('_id').lean();
    const price = plan
      ? await PlanPriceModel.findOne({
          posProductCode: sku.posProductCode ?? DEFAULT_POS_VERTICAL,
          planId: plan._id,
          billingCycle: target.billingCycle,
          effectiveFrom: { $lte: new Date() },
          $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }],
        })
          .sort({ effectiveFrom: -1 })
          .lean()
      : null;
    mapped.push({
      sku: sku.code,
      plan: target.plan,
      billingCycle: target.billingCycle,
      skuPriceMinor: sku.priceMinor,
      enginePriceMinor: price?.amountMinor ?? null,
      matches: price?.amountMinor === sku.priceMinor,
    });
  }

  return { plansCreated, pricesCreated, mapped, unmapped };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  await Promise.all([CatalogPlanModel.syncIndexes(), PlanPriceModel.syncIndexes()]);
  const report = await backfillPricingCatalog();
  logger.info('Pricing catalog ready', { plansCreated: report.plansCreated, pricesCreated: report.pricesCreated, unmapped: report.unmapped });
  const mismatches = report.mapped.filter((row) => !row.matches);
  if (mismatches.length > 0) logger.warn('Some plan SKUs are priced differently from the pricing engine (left unchanged)', { mismatches });
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('backfillPricingCatalog')) {
  main().catch((error) => {
    logger.error('Pricing catalog backfill failed', { error: String(error) });
    process.exit(1);
  });
}
