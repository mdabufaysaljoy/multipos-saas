/**
 * Display copy of the server's loyalty maths (server/src/modules/loyalty/loyalty.math.ts).
 * The till uses it to preview; the server recalculates everything on checkout.
 */

/** A scanned code shaped like a loyalty card (EAN-13 in the 299 range with a valid check digit). */
export function isLoyaltyCardCode(code: string): boolean {
  if (!/^299\d{10}$/.test(code)) return false;
  const sum = code
    .slice(0, 12)
    .split('')
    .reduce((acc, digit, index) => acc + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

/** Whole points earned by a qualifying amount (৳999 at ৳100 per point = 9). */
export const pointsForSpend = (qualifyingMinor: number, earnSpendMinor: number) =>
  qualifyingMinor > 0 && earnSpendMinor > 0 ? Math.floor(qualifyingMinor / earnSpendMinor) : 0;

/** The most points that can be spent on an amount: never more than the balance or the amount. */
export const maxRedeemablePoints = (amountMinor: number, pointValueMinor: number, balance: number) =>
  amountMinor > 0 && pointValueMinor > 0 && balance > 0 ? Math.min(balance, Math.floor(amountMinor / pointValueMinor)) : 0;

/**
 * Preview of a return's effect on a loyalty sale, mirroring the server's
 * cumulative rule: kept goods keep the points they would earn; redeemed points
 * come back in proportion to the value returned (all of them on a full return)
 * and are deducted from the money refund.
 */
export function previewReturn(
  sale: { subtotalMinor: number; returnedValueMinor: number },
  loyalty: { earnSpendMinor: number; pointValueMinor: number; pointsRedeemed: number; qualifyingMinor: number; pointsEarned: number; pointsEarnedReversed: number; pointsRedeemedRestored: number },
  returningValueMinor: number,
) {
  const subtotal = Math.max(1, sale.subtotalMinor);
  const returned = Math.min(subtotal, sale.returnedValueMinor + returningValueMinor);
  const fully = returned >= subtotal;
  const keptQualifying = fully ? 0 : Math.floor((loyalty.qualifyingMinor * (subtotal - returned)) / subtotal);
  const earnedKept = fully ? 0 : Math.min(loyalty.pointsEarned, Math.floor(keptQualifying / Math.max(1, loyalty.earnSpendMinor)));
  const earnTarget = Math.max(loyalty.pointsEarnedReversed, loyalty.pointsEarned - earnedKept);
  const restoreTarget = Math.max(loyalty.pointsRedeemedRestored, fully ? loyalty.pointsRedeemed : Math.floor((loyalty.pointsRedeemed * returned) / subtotal));
  const pointsRestored = restoreTarget - loyalty.pointsRedeemedRestored;
  return {
    pointsEarnedReversed: earnTarget - loyalty.pointsEarnedReversed,
    pointsRedeemedRestored: pointsRestored,
    valueMinor: pointsRestored * loyalty.pointValueMinor,
  };
}
