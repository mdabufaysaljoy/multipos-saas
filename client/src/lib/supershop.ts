import type { ShopUnitType } from '@/types/supershop';

/** "1.25" from 1250 grams; trailing zeros dropped. */
export function gramsToKgText(grams: number): string {
  const whole = Math.floor(grams / 1000);
  const rest = grams % 1000;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(3, '0').replace(/0+$/, '')}`;
}

/**
 * The same two ceilings the server applies (`server/src/models/shopUnits.ts`).
 * Kept in step deliberately: a till that lets someone type an amount the API
 * will refuse turns a clear limit into an unexplained failure.
 */
export const MAX_PIECES = 1_000_000;
/** 100 tonnes, in grams. */
export const MAX_GRAMS = 100_000_000;

/**
 * Parses a kilogram amount typed by a person ("1.25", "0.5", "1500") into grams,
 * by splitting the string - no floating point, so 0.1 kg is exactly 100 g.
 * Returns null for anything that is not a positive amount with at most 3
 * decimals, or for more than the server will accept.
 */
export function parseKgToGrams(raw: string): number | null {
  const match = /^(\d{1,6})(?:\.(\d{0,3}))?$/.exec(raw.trim());
  if (!match) return null;
  const grams = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
  return grams > 0 && grams <= MAX_GRAMS ? grams : null;
}

/** "3" or "1.25 kg" */
export const formatQuantity = (quantity: number, unitType: ShopUnitType) =>
  unitType === 'weight' ? `${gramsToKgText(quantity)} kg` : String(quantity);

/** The same integer rounding the server uses; for previews only. */
export const lineAmount = (unitPriceMinor: number, quantity: number, unitType: ShopUnitType) =>
  unitType === 'weight' ? Math.floor((unitPriceMinor * quantity + 500) / 1000) : unitPriceMinor * quantity;

export const formatVatRate = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

/** "15" or "7.5" -> basis points; null if invalid. */
export function parseVatPercent(raw: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(raw.trim());
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bps <= 10_000 ? bps : null;
}

export const vatPercentText = (bps: number) => (bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(2).replace(/0$/, ''));
