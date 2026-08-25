/**
 * Quantity handling for the POS.
 *
 * Clothing sells in whole pieces, so a quantity field accepts digits and
 * nothing else. There is no rounding, no coercion and no fallback value: an
 * empty field parses to `null` and the caller decides what that means. This is
 * what prevents the classic "backspace turns 1 into 0.001" defect, because
 * there is no code path that ever invents a number for an empty input.
 */

/** Digits only. Empty is a valid intermediate state while typing. */
const INTEGER_PATTERN = /^\d*$/;

export const isQuantityDraft = (raw: string): boolean => INTEGER_PATTERN.test(raw.trim());

/** "12" -> 12, "" -> null, "1.5" -> null, "abc" -> null. */
export function parseQuantity(raw: string): number | null {
  const cleaned = raw.trim();
  if (cleaned === '') return null;
  if (!INTEGER_PATTERN.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export const isValidSaleQuantity = (value: number | null): value is number =>
  value !== null && Number.isSafeInteger(value) && value > 0;

export const isValidSalePrice = (minor: number | null): minor is number =>
  minor !== null && Number.isSafeInteger(minor) && minor > 0;

/** Strips anything that is not a digit, for paste handling. */
export const sanitizeDigits = (raw: string): string => raw.replace(/\D/g, '');

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
