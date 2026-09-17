import type { Types } from 'mongoose';
import type { BillingCycle } from '../../models/PlanPrice';
import type { SubscriptionPlanDoc } from '../../models/SubscriptionPlan';
import { ApiError } from '../../utils/ApiError';
import { pricingService } from '../pricing/pricing.service';
import { verticalOfTenant } from './planEntitlements';

type PricedPlan = Pick<SubscriptionPlanDoc, 'code' | 'priceMinor' | 'currency' | 'interval'>;

/** What buying one plan SKU costs, and where that number came from. */
export interface PurchaseOffer {
  /** `catalog`: the pricing engine. `plan`: a bespoke SKU with no catalog entry, at its own stored price. */
  source: 'catalog' | 'plan';
  posType: string;
  catalogPlanCode: string | null;
  billingCycle: BillingCycle;
  priceId: Types.ObjectId | null;
  /** Before any coupon. Integer minor units. */
  listPriceMinor: number;
  currency: string;
  paidMonths: number;
  freeMonths: number;
  savingsMinor: number;
}

/**
 * The price of a plan SKU for a POS type - the single answer every purchase
 * path uses (online checkout, wallet, manual request, coupon quotes, plan
 * options, pricing pages).
 *
 * A SKU in the catalog (`starter-store-*`, `showroom-*`, `brand-*`) is priced by
 * the pricing engine for that POS type, so an admin price change reaches every
 * path at once, and an inactive engine price refuses the purchase. A SKU with no
 * catalog entry (a bespoke plan) keeps its own stored price. Either way the
 * number is decided on the server; nothing a client sends is involved.
 */
export async function offerFor(posType: string, plan: PricedPlan): Promise<PurchaseOffer> {
  const mapping = await pricingService.catalogPlanForLegacyCode(plan.code);
  if (!mapping) {
    const billingCycle: BillingCycle = plan.interval === 'yearly' ? 'annual' : 'monthly';
    return {
      source: 'plan',
      posType,
      catalogPlanCode: null,
      billingCycle,
      priceId: null,
      listPriceMinor: plan.priceMinor,
      currency: plan.currency,
      paidMonths: billingCycle === 'annual' ? 12 : 1,
      freeMonths: 0,
      savingsMinor: 0,
    };
  }

  // Existing workspaces keep buying even if their POS type stopped taking new ones.
  const quote = await pricingService.quote({ posType, plan: mapping.plan, billingCycle: mapping.billingCycle }, new Date(), {
    allowInactivePosProduct: true,
  });
  return {
    source: 'catalog',
    posType,
    catalogPlanCode: mapping.plan,
    billingCycle: mapping.billingCycle,
    priceId: quote.priceId,
    listPriceMinor: quote.amountMinor,
    currency: quote.currency,
    paidMonths: quote.paidMonths,
    freeMonths: quote.freeMonths,
    savingsMinor: quote.savingsMinor,
  };
}

/** The offer for a workspace, priced for its own POS type (read from the database, never the request). */
export async function offerForPlan(tenantId: Types.ObjectId, plan: PricedPlan): Promise<PurchaseOffer> {
  return offerFor(await verticalOfTenant(tenantId), plan);
}

/** For listings: a plan with no purchasable price is simply not offered. */
export async function tryOfferFor(posType: string, plan: PricedPlan): Promise<PurchaseOffer | null> {
  try {
    return await offerFor(posType, plan);
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'CONFLICT' || error.code === 'NOT_FOUND')) return null;
    throw error;
  }
}

/** The record of how a purchase was priced, kept on requests and payments. */
export const pricingRecordOf = (offer: PurchaseOffer) => ({
  source: offer.source,
  posType: offer.posType,
  catalogPlanCode: offer.catalogPlanCode,
  billingCycle: offer.billingCycle,
  priceId: offer.priceId,
  listPriceMinor: offer.listPriceMinor,
  currency: offer.currency,
});
