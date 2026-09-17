/**
 * Client-side mirror of the server's money rules.
 *
 * Money is an INTEGER number of minor units everywhere. The only place a
 * decimal string exists is the text a human types, and converting it back is
 * done with string arithmetic - never `parseFloat(x) * 100`, which turns
 * "19.99" into 1998.9999999999998.
 */
export const MINOR_PER_MAJOR = 100;

/** Digits, at most one dot, at most two decimals. Empty string is allowed. */
const MONEY_PATTERN = /^\d*(\.\d{0,2})?$/;

export const isMoneyDraft = (raw: string): boolean => raw === '' || MONEY_PATTERN.test(raw);

/**
 * "1234.5" -> 123450. Returns null for an empty or malformed string, so an
 * empty input stays genuinely empty instead of silently becoming a number.
 */
export function parseMoneyToMinor(raw: string): number | null {
  const cleaned = raw.trim().replace(/,/g, '');
  if (cleaned === '' || cleaned === '.') return null;
  if (!MONEY_PATTERN.test(cleaned)) return null;

  const [wholeRaw = '', fracRaw = ''] = cleaned.split('.');
  const whole = wholeRaw === '' ? 0 : Number(wholeRaw);
  // Pad so ".5" reads as 50 poisha, not 5.
  const frac = Number((fracRaw + '00').slice(0, 2));

  const value = whole * MINOR_PER_MAJOR + frac;
  return Number.isSafeInteger(value) ? value : null;
}

/** 123450 -> "1234.50" */
export function minorToMoneyString(minor: number): string {
  const negative = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const whole = Math.floor(abs / MINOR_PER_MAJOR);
  const frac = abs % MINOR_PER_MAJOR;
  return `${negative ? '-' : ''}${whole}.${String(frac).padStart(2, '0')}`;
}

/** 123450 -> "৳ 1,234.50" */
export function formatMoney(minor: number | null | undefined, currency = 'BDT'): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return '—';
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const negative = minor < 0;
  const [whole, frac] = minorToMoneyString(Math.abs(minor)).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol}${grouped}.${frac}`;
}

/** Compact form for chart axes and tight table cells. */
export function formatMoneyCompact(minor: number, currency = 'BDT'): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const major = minor / MINOR_PER_MAJOR;
  if (Math.abs(major) >= 10_000_000) return `${symbol}${(major / 10_000_000).toFixed(1)}Cr`;
  if (Math.abs(major) >= 100_000) return `${symbol}${(major / 100_000).toFixed(1)}L`;
  if (Math.abs(major) >= 1_000) return `${symbol}${(major / 1_000).toFixed(1)}k`;
  return `${symbol}${major.toFixed(0)}`;
}

/**
 * Subscription prices: "৳1,990", "৳29,900". Whole amounts drop the ".00" so a
 * price reads like a price; anything with poisha keeps them. The value is
 * still the plan's own `priceMinor` from the API, never a constant.
 */
export function formatPlanPrice(minor: number, currency = 'BDT'): string {
  if (minor % MINOR_PER_MAJOR !== 0) return formatMoney(minor, currency).replace(/^(-?)(\S+) /, '$1$2');
  const symbol = (CURRENCY_SYMBOLS[currency] ?? `${currency} `).trim();
  const grouped = String(Math.abs(minor) / MINOR_PER_MAJOR).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${minor < 0 ? '-' : ''}${symbol}${grouped}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  BDT: '৳ ',
  USD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
};

/** Percentage in basis points -> "7.5%" */
export const formatBasisPoints = (bps: number): string => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
