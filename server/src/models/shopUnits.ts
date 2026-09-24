import type { ShopUnitType } from './ShopProduct';

// All integer arithmetic. Weighed goods: price per kg, quantity in grams.

/** What a quantity costs at a unit price, rounded half-up to the minor unit. */
export const lineAmount = (unitPriceMinor: number, quantity: number, unitType: ShopUnitType): number =>
  unitType === 'weight' ? Math.floor((unitPriceMinor * quantity + 500) / 1000) : unitPriceMinor * quantity;

/** VAT contained in a VAT-inclusive amount at a rate in basis points, rounded half-up. */
export const includedVat = (grossMinor: number, rateBps: number): number =>
  rateBps <= 0 ? 0 : Math.floor((grossMinor * rateBps + Math.floor((10_000 + rateBps) / 2)) / (10_000 + rateBps));

/** "3" or "1.25 kg" - for messages. */
export const describeQuantity = (quantity: number, unitType: ShopUnitType) =>
  unitType === 'weight' ? `${(quantity / 1000).toFixed(3).replace(/\.?0+$/, '')} kg` : String(quantity);
