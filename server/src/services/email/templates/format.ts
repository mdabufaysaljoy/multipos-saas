import { BRANDING } from '../../../config/branding';

export const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Subjects are headers: no line breaks may reach them. */
export const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim().slice(0, 150);

/** Integer minor units -> "৳1,990.00". No floating-point money maths. */
export function formatMoney(minor: number, currency = 'BDT') {
  const negative = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const major = Math.trunc(abs / 100).toLocaleString('en-US');
  const cents = String(abs % 100).padStart(2, '0');
  const symbol = currency.toUpperCase() === 'BDT' ? '৳' : `${currency.toUpperCase()} `;
  return `${negative ? '-' : ''}${symbol}${major}.${cents}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Calendar parts of an instant in the business timezone (month is 1-based). */
function partsIn(value: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BRANDING.timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return { day: get('day'), month: Number(get('month')), year: get('year'), hour: get('hour'), minute: get('minute'), dayPeriod: get('dayPeriod') };
}

/** "20 Sep 2026", in the business timezone (a fixed format, whatever the runtime's locale data). */
export function formatDay(value: Date | null | undefined) {
  if (!value) return '';
  const p = partsIn(value);
  return `${p.day.padStart(2, '0')} ${MONTHS[p.month - 1]} ${p.year}`;
}

/** "20 Sep 2026, 10:31 AM", in the business timezone. */
export function formatDateTime(value: Date | null | undefined) {
  if (!value) return '';
  const p = partsIn(value);
  return `${formatDay(value)}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

const METHOD_LABELS: Record<string, string> = {
  wallet: 'Wallet',
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
  bank: 'Bank transfer',
  card: 'Card',
  uddoktapay: 'UddoktaPay',
  manual: 'Manual payment',
  cash: 'Cash',
};
export const paymentMethodLabel = (method: string | null | undefined) =>
  method ? (METHOD_LABELS[method.toLowerCase()] ?? method.charAt(0).toUpperCase() + method.slice(1)) : '';

const POS_LABELS: Record<string, string> = { clothing: 'Clothing POS', restaurant: 'Restaurant POS', pharmacy: 'Pharmacy POS', supershop: 'Supershop POS' };
export const posLabel = (code: string | null | undefined) => (code ? (POS_LABELS[code] ?? `${code} POS`) : '');
