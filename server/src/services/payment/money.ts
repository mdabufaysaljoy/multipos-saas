/**
 * Exact conversion between integer minor units (poisha) and the decimal strings
 * payment gateways use ("990.00"). No floating point anywhere: 0.1 + 0.2 must
 * never decide whether a customer paid enough.
 */

/** 99000 -> "990.00" */
export function minorToDecimalString(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error('Amount must be a non-negative whole number of minor units');
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/**
 * "990" | "990.5" | "990.50" -> 99050. Anything else (signs, separators,
 * exponents, more than two decimals, empty) is not a trustworthy amount: null.
 */
export function decimalStringToMinor(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string') return null;
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}
