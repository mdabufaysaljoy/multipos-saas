import * as React from 'react';
import type { PaymentMethod } from '@/types/domain';
import { computePayments, type PaymentBreakdown } from './paymentMath';

export interface PaymentRow {
  id: string;
  method: PaymentMethod;
  /**
   * Cash row: the cash RECEIVED from the customer (may exceed what is due).
   * Other rows: the amount paid by that method. null while being edited.
   */
  amountMinor: number | null;
}

let rowSeq = 0;
const nextId = () => `pay-${(rowSeq += 1)}`;

/** Cash first: it is the default method. */
const PRIMARY_METHOD: PaymentMethod = 'cash';

export interface PaymentsState extends PaymentBreakdown {
  rows: PaymentRow[];
  isSettled: boolean;
}

/**
 * Payment entry for the POS.
 *
 * Cash is what the customer actually hands over; the maths in `paymentMath`
 * works out how much of it settles the sale and how much is change. Until the
 * cashier types a cash amount it follows what is due (exact cash); once typed,
 * it is never overwritten - adding or changing another method only moves what
 * is due and the change.
 */
export function usePayments(totalMinor: number) {
  const [rows, setRows] = React.useState<PaymentRow[]>([{ id: nextId(), method: PRIMARY_METHOD, amountMinor: null }]);
  const [cashTyped, setCashTyped] = React.useState(false);

  const breakdown = computePayments(totalMinor, rows);

  // Untouched cash follows what is due, so an exact cash sale needs no typing.
  const dueForCash = breakdown.remainingPayableMinor;
  const cashAmountMinor = rows.find((row) => row.method === 'cash')?.amountMinor ?? null;
  const exactCashMinor = totalMinor > 0 && dueForCash > 0 ? dueForCash : null;
  React.useEffect(() => {
    if (cashTyped || cashAmountMinor === exactCashMinor) return;
    setRows((prev) => prev.map((row) => (row.method === 'cash' ? { ...row, amountMinor: exactCashMinor } : row)));
    // Comparing against what is there keeps this idempotent, so it can also
    // refill after `reset()` - a dialog that opens a second time on the same
    // total starts at exact cash, exactly as it did the first time.
  }, [cashTyped, cashAmountMinor, exactCashMinor]);

  const setAmount = (id: string, amountMinor: number | null) => {
    if (rows.find((row) => row.id === id)?.method === 'cash') setCashTyped(true);
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, amountMinor } : row)));
  };

  const setMethod = (id: string, method: PaymentMethod) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, method, amountMinor: method === 'cash' || row.method === 'cash' ? null : row.amountMinor } : row)));
    // A row becoming (or leaving) cash starts again from "exact cash".
    setCashTyped(false);
  };

  const addRow = (method: PaymentMethod) => {
    setRows((prev) => (prev.some((row) => row.method === method) ? prev : [...prev, { id: nextId(), method, amountMinor: null }]));
  };

  const removeRow = (id: string) => {
    const index = rows.findIndex((row) => row.id === id);
    if (index <= 0) return;
    if (rows[index].method === 'cash') setCashTyped(false);
    setRows((prev) => prev.filter((row) => row.id !== id));
  };

  const reset = React.useCallback(() => {
    setCashTyped(false);
    setRows([{ id: nextId(), method: PRIMARY_METHOD, amountMinor: null }]);
  }, []);

  const state: PaymentsState = {
    ...breakdown,
    rows,
    isSettled: totalMinor > 0 && breakdown.issues.length === 0,
  };

  return { ...state, cashTyped, setAmount, setMethod, addRow, removeRow, reset };
}
