import type { PaymentMethod } from '@/types/domain';

export interface PaymentRowInput {
  method: PaymentMethod;
  /** Cash row: cash RECEIVED from the customer. Other rows: amount applied to the sale. */
  amountMinor: number | null;
}

export interface PaymentBreakdown {
  /** What the sale still needs after every non-cash method. */
  remainingPayableMinor: number;
  /** Cash handed over; null when the cash field is empty. */
  cashTenderedMinor: number | null;
  /** The part of the cash that settles the sale. */
  cashAppliedMinor: number;
  changeMinor: number;
  /** Still unpaid after everything entered. */
  dueMinor: number;
  /** One row per method, with the amount APPLIED to the sale (what is recorded). */
  applied: { method: PaymentMethod; amountMinor: number }[];
  hasCash: boolean;
  issues: string[];
}

/**
 * The till's payment maths, in integer minor units only.
 *
 *   remainingPayable = total - other (non-cash) payments
 *   cashApplied      = min(cashTendered, remainingPayable)
 *   change           = max(cashTendered - remainingPayable, 0)
 *   due              = max(remainingPayable - cashTendered, 0)
 *
 * Without a cash row, the first method covers whatever the others leave.
 * Change is never part of what the sale records.
 */
export function computePayments(totalMinor: number, rows: PaymentRowInput[]): PaymentBreakdown {
  const cashIndex = rows.findIndex((row) => row.method === 'cash');
  const hasCash = cashIndex !== -1;
  const issues: string[] = [];

  // Without cash, the first method is derived; with cash, every non-cash method is typed.
  const typed = rows.filter((row, index) => row.method !== 'cash' && (hasCash || index > 0));
  const typedMinor = typed.reduce((sum, row) => sum + (row.amountMinor ?? 0), 0);

  if (typed.some((row) => row.amountMinor === null)) issues.push('Enter an amount for every added payment method');
  else if (typed.some((row) => (row.amountMinor ?? 0) <= 0)) issues.push('Every payment amount must be greater than zero');

  const remainingPayableMinor = Math.max(totalMinor - typedMinor, 0);
  if (totalMinor > 0 && typedMinor > totalMinor) issues.push('The other methods add up to more than the total');

  if (!hasCash) {
    const applied = rows.map((row, index) => ({ method: row.method, amountMinor: index === 0 ? remainingPayableMinor : (row.amountMinor ?? 0) }));
    if (totalMinor > 0 && rows.length > 1 && remainingPayableMinor <= 0) {
      issues.push('The added methods already cover the whole total - remove one or lower its amount');
    }
    return { remainingPayableMinor, cashTenderedMinor: null, cashAppliedMinor: 0, changeMinor: 0, dueMinor: 0, applied, hasCash, issues };
  }

  const cashTenderedMinor = rows[cashIndex].amountMinor;
  const tendered = cashTenderedMinor ?? 0;
  const cashAppliedMinor = Math.min(tendered, remainingPayableMinor);
  const changeMinor = Math.max(tendered - remainingPayableMinor, 0);
  const dueMinor = Math.max(remainingPayableMinor - tendered, 0);

  if (totalMinor > 0 && issues.length === 0) {
    if (remainingPayableMinor === 0) issues.push('The other methods already cover the whole total - remove Cash');
    else if (cashTenderedMinor === null) issues.push('Enter the cash received');
    else if (dueMinor > 0) issues.push(`Remaining due ${(dueMinor / 100).toFixed(2)} - collect the full amount`);
  }

  const applied = rows.map((row) => ({ method: row.method, amountMinor: row.method === 'cash' ? cashAppliedMinor : (row.amountMinor ?? 0) }));
  return { remainingPayableMinor, cashTenderedMinor, cashAppliedMinor, changeMinor, dueMinor, applied, hasCash, issues };
}

/**
 * The payment rows a Super Shop, Pharmacy or Restaurant sale is sent with.
 *
 * Those three have no separate "cash received" field: their rows are what was
 * TENDERED, and whatever exceeds the total is the change. So the cash row
 * carries the cash handed over, and every other row carries what it paid. The
 * server works out the change from the same numbers, and refuses any tender
 * where the excess did not come from cash.
 *
 * Clothing sends `applied` plus `cashTenderedMinor` instead, because its sale
 * records what was applied and the cash handed over separately. Same maths,
 * two shapes - task 03 is where they converge.
 */
export function tenderedRows(breakdown: PaymentBreakdown): { method: PaymentMethod; amountMinor: number }[] {
  return breakdown.applied.map((row) =>
    row.method === 'cash' ? { method: row.method, amountMinor: breakdown.cashTenderedMinor ?? row.amountMinor } : row,
  );
}
