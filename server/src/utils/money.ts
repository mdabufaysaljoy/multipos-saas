/**
 * Money is represented as an integer number of MINOR units (e.g. poisha, cents)
 * everywhere in the database and API. Floating point never touches a monetary
 * value, which removes an entire class of rounding bugs.
 */
export const MINOR_UNITS_PER_MAJOR = 100;

/** Type-brand for readability at call sites. */
export type Minor = number;

export const isValidMinor = (value: unknown): value is Minor =>
  typeof value === 'number' && Number.isSafeInteger(value);

/**
 * Parses a human string ("1234.5", "1,234.50", "") into minor units WITHOUT
 * floating point. Returns null when the input is not a well-formed amount.
 */
export function parseMajorToMinor(input: string | number): Minor | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    // Round half-up on the minor unit; guards against 19.99 * 100 = 1998.9999
    return Math.round(input * MINOR_UNITS_PER_MAJOR);
  }
  const cleaned = input.trim().replace(/,/g, '');
  if (cleaned === '') return null;
  if (!/^-?\d*(\.\d*)?$/.test(cleaned)) return null;

  const negative = cleaned.startsWith('-');
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [wholeRaw = '', fracRaw = ''] = unsigned.split('.');
  const whole = wholeRaw === '' ? '0' : wholeRaw;
  const frac = (fracRaw + '00').slice(0, 2);

  const value = Number(whole) * MINOR_UNITS_PER_MAJOR + Number(frac);
  if (!Number.isSafeInteger(value)) return null;
  return negative ? -value : value;
}

/** Formats minor units as a plain decimal string, e.g. 123450 -> "1234.50". */
export function formatMinor(minor: Minor): string {
  const negative = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const whole = Math.floor(abs / MINOR_UNITS_PER_MAJOR);
  const frac = abs % MINOR_UNITS_PER_MAJOR;
  return `${negative ? '-' : ''}${whole}.${String(frac).padStart(2, '0')}`;
}

/**
 * unitPrice * quantity, kept in integers. Quantity must be an integer, which the
 * validators guarantee before this is ever called.
 */
export function lineTotal(unitPriceMinor: Minor, quantity: number): Minor {
  return unitPriceMinor * quantity;
}

/**
 * Applies a percentage in basis points (1% = 100bps) to an amount, rounding
 * half-up so the sum of parts never silently loses a unit.
 */
export function applyBasisPoints(amountMinor: Minor, basisPoints: number): Minor {
  return Math.round((amountMinor * basisPoints) / 10_000);
}

/** Clamps a discount so it can never exceed the amount it applies to. */
export function clampDiscount(discountMinor: Minor, amountMinor: Minor): Minor {
  if (discountMinor <= 0) return 0;
  return Math.min(discountMinor, amountMinor);
}
