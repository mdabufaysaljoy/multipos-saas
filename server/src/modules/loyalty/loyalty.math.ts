/**
 * Loyalty arithmetic. Pure integer maths on minor units and whole points, so the
 * same rules can be tested without a database and never meet a float.
 *
 * Calculation order at checkout (the backend's; the POS only mirrors it):
 *   1. subtotal          = sum(line price x qty)            line prices, incl. permitted overrides
 *   2. cart discount     = fixed / percent of subtotal       the existing order discount
 *   3. loyalty discount  = points redeemed x point value     at most (subtotal - cart discount)
 *   4. taxable           = subtotal - cart discount - loyalty discount
 *   5. VAT               = on taxable, when charged on top   (existing rule)
 *   6. total             = taxable + VAT
 *   Points earned        = floor(taxable / spend per point)  - VAT never earns points
 */

/** Whole points earned by a qualifying amount; partial earning units earn nothing (৳999 at ৳100 = 9). */
export function pointsForSpend(qualifyingMinor: number, earnSpendMinor: number): number {
  if (qualifyingMinor <= 0 || earnSpendMinor <= 0) return 0;
  return Math.floor(qualifyingMinor / earnSpendMinor);
}

/** The largest number of points that may be redeemed on an amount (the discount can never exceed it). */
export function maxRedeemablePoints(amountMinor: number, pointValueMinor: number, balance: number): number {
  if (amountMinor <= 0 || pointValueMinor <= 0 || balance <= 0) return 0;
  return Math.min(balance, Math.floor(amountMinor / pointValueMinor));
}

export interface SaleLoyaltySnapshot {
  earnSpendMinor: number;
  pointsRedeemed: number;
  qualifyingMinor: number;
  pointsEarned: number;
  pointsEarnedReversed: number;
  pointsRedeemedRestored: number;
}

/**
 * What the goods returned so far should have done to the points, as CUMULATIVE
 * targets. Callers apply only the difference from what earlier returns already
 * did, so a sale returned in several parts ends exactly where one full return
 * would, with no rounding drift.
 *
 *   returned share    = returnedValue / subtotal       (line prices, like the refund itself)
 *   earned, kept      = points the KEPT goods would earn: floor(qualifying x kept share / spend)
 *   earned, reversed  = pointsEarned - earned kept
 *   redeemed, restored= floor(pointsRedeemed x returned share); everything once fully returned
 */
export function returnTargets(sale: SaleLoyaltySnapshot, subtotalMinor: number, returnedValueMinor: number) {
  const fully = subtotalMinor <= 0 || returnedValueMinor >= subtotalMinor;
  const returned = BigInt(Math.max(0, Math.min(returnedValueMinor, subtotalMinor)));
  const subtotal = BigInt(Math.max(1, subtotalMinor));

  const keptQualifying = fully ? 0n : (BigInt(sale.qualifyingMinor) * (subtotal - returned)) / subtotal;
  const earnedKept = fully ? 0 : Math.min(sale.pointsEarned, Number(keptQualifying / BigInt(Math.max(1, sale.earnSpendMinor))));
  const earnReversedTarget = sale.pointsEarned - earnedKept;

  const redeemRestoredTarget = fully ? sale.pointsRedeemed : Number((BigInt(sale.pointsRedeemed) * returned) / subtotal);

  return {
    earnReversedTarget: Math.max(sale.pointsEarnedReversed, earnReversedTarget),
    redeemRestoredTarget: Math.max(sale.pointsRedeemedRestored, redeemRestoredTarget),
  };
}
