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

/**
 * How much of one product a branch may hold, count or move at once.
 *
 * Two unit systems share one field, so one ceiling cannot serve both: a
 * `quantity` of 1,000,000 is a million pieces, but for weighed goods it is
 * 1,000,000 GRAMS - exactly 1000 kg, which a supershop receiving rice or sugar
 * passes in a single delivery.
 *
 * The schema can only bound the number (integer, positive, safe); it does not
 * know the product. So the schema allows the wider of the two and the service
 * narrows it once the product - and therefore its unit - has been read.
 */
export const MAX_PIECES = 1_000_000;
/** 100 tonnes. Well inside `Number.isSafeInteger` once multiplied by a price. */
export const MAX_GRAMS = 100_000_000;
/** The widest quantity any unit type allows; the bound a schema can apply. */
export const MAX_BASE_QUANTITY = MAX_GRAMS;

/** The ceiling that actually applies to this product. */
export const maxQuantityFor = (unitType: ShopUnitType): number => (unitType === 'weight' ? MAX_GRAMS : MAX_PIECES);

/** How that ceiling reads to a person: "1000000" or "100000 kg". */
export const describeMaxQuantity = (unitType: ShopUnitType): string =>
  unitType === 'weight' ? `${MAX_GRAMS / 1000} kg` : String(MAX_PIECES);
