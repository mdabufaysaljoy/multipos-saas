type BadgeVariant = 'success' | 'warning' | 'destructive' | 'secondary';

export const INVOICE_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  paid: { label: 'Paid', variant: 'success' },
  partially_refunded: { label: 'Partly refunded', variant: 'warning' },
  refunded: { label: 'Refunded', variant: 'secondary' },
};

export const PAYMENT_STATUS_LABEL: Record<string, { label: string; variant: BadgeVariant }> = {
  paid: { label: 'Paid', variant: 'success' },
  pending: { label: 'Pending', variant: 'warning' },
  failed: { label: 'Failed', variant: 'destructive' },
  cancelled: { label: 'Cancelled', variant: 'secondary' },
  refunded: { label: 'Refunded', variant: 'secondary' },
};

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  wallet: 'Wallet',
  bkash: 'bKash',
  nagad: 'Nagad',
  bank: 'Bank transfer',
  manual: 'Manual',
  provider_portal: 'Provider',
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
};

export const INVOICE_KIND_LABEL: Record<string, string> = {
  purchase: 'New plan',
  upgrade: 'Upgrade',
  downgrade: 'Downgrade',
  'cycle-change': 'Billing cycle change',
  renewal: 'Renewal',
  assigned: 'Recorded payment',
};

export const STATEMENT_CATEGORY_LABEL: Record<string, string> = {
  topup: 'Top-up',
  subscription: 'Subscription',
  sms: 'SMS',
  email: 'Email',
  ai: 'AI',
  storage: 'Storage',
  adjustment: 'Adjustment',
  refund: 'Refund',
  other: 'Other',
};

/** Minor units as a plain decimal string for exports, without floating point. */
export function minorToPlain(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * One CSV cell. Quoted, with quotes doubled, and a leading = + - @ tab or CR
 * neutralised so a spreadsheet never runs text from the ledger as a formula.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
