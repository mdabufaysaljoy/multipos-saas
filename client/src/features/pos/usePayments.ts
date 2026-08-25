import * as React from 'react';
import type { PaymentMethod } from '@/types/domain';

export interface PaymentRow {
  id: string;
  method: PaymentMethod;
  /** null while the field is being edited - never coerced to a number. */
  amountMinor: number | null;
}

let rowSeq = 0;
const nextId = () => `pay-${(rowSeq += 1)}`;

/** Cash first: it is the default tender and the one auto-allocation adjusts. */
const PRIMARY_METHOD: PaymentMethod = 'cash';

export interface PaymentsState {
  rows: PaymentRow[];
  allocatedMinor: number;
  remainingMinor: number;
  changeMinor: number;
  isSettled: boolean;
  issues: string[];
}

/**
 * Split-payment allocation for the POS.
 *
 * Behaviour required by the till:
 *  - the first row defaults to Cash and carries the whole total
 *  - adding a second method and typing an amount REDUCES the first row by the
 *    same amount, so the running allocation still equals the total
 *  - a third, fourth… method reduces the first row again
 *  - no row may go negative, and the allocation may never exceed the total
 *    unless the surplus is genuine cash tendered (which becomes change)
 */
export function usePayments(totalMinor: number) {
  const [rows, setRows] = React.useState<PaymentRow[]>([
    { id: nextId(), method: PRIMARY_METHOD, amountMinor: null },
  ]);

  // While the cashier has not touched the amounts, the single row simply
  // tracks the running total, so the common one-tender sale needs no input.
  const [touched, setTouched] = React.useState(false);

  React.useEffect(() => {
    if (touched) return;
    setRows((prev) =>
      prev.length === 1 ? [{ ...prev[0], amountMinor: totalMinor > 0 ? totalMinor : null }] : prev,
    );
  }, [totalMinor, touched]);

  const sumOf = (list: PaymentRow[]) => list.reduce((sum, row) => sum + (row.amountMinor ?? 0), 0);

  /**
   * Rebalances the primary (first) row so the allocation lands back on the
   * total. Never produces a negative amount.
   */
  const rebalance = (list: PaymentRow[]): PaymentRow[] => {
    if (list.length <= 1) return list;
    const [primary, ...rest] = list;
    const others = sumOf(rest);
    const remainder = totalMinor - others;
    return [{ ...primary, amountMinor: remainder > 0 ? remainder : 0 }, ...rest];
  };

  const setAmount = (id: string, amountMinor: number | null) => {
    setTouched(true);
    setRows((prev) => {
      const index = prev.findIndex((row) => row.id === id);
      if (index === -1) return prev;

      const next = prev.map((row) => (row.id === id ? { ...row, amountMinor } : row));

      // Editing a secondary row pulls the difference out of the primary row.
      // Editing the primary row itself is taken at face value - the cashier is
      // deliberately over-tendering (cash) or under-allocating.
      if (index === 0) return next;
      return rebalance(next);
    });
  };

  const setMethod = (id: string, method: PaymentMethod) => {
    setTouched(true);
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, method } : row)));
  };

  const addRow = (method: PaymentMethod) => {
    setTouched(true);
    setRows((prev) => {
      if (prev.some((row) => row.method === method)) return prev;
      return [...prev, { id: nextId(), method, amountMinor: null }];
    });
  };

  const removeRow = (id: string) => {
    setTouched(true);
    setRows((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((row) => row.id !== id);
      // Give the freed amount back to the primary row.
      return rebalance(next);
    });
  };

  const reset = React.useCallback(() => {
    setTouched(false);
    setRows([{ id: nextId(), method: PRIMARY_METHOD, amountMinor: null }]);
  }, []);

  const allocatedMinor = sumOf(rows);
  const remainingMinor = Math.max(0, totalMinor - allocatedMinor);
  const changeMinor = Math.max(0, allocatedMinor - totalMinor);

  const issues: string[] = [];
  if (totalMinor > 0) {
    if (rows.some((row) => row.amountMinor === null)) {
      issues.push('Enter an amount for every payment method');
    } else if (rows.some((row) => (row.amountMinor ?? 0) <= 0)) {
      issues.push('Every payment amount must be greater than zero');
    } else if (allocatedMinor < totalMinor) {
      issues.push(`Short by ${((totalMinor - allocatedMinor) / 100).toFixed(2)} — collect the full amount`);
    }
  }

  const state: PaymentsState = {
    rows,
    allocatedMinor,
    remainingMinor,
    changeMinor,
    isSettled: totalMinor > 0 && issues.length === 0,
    issues,
  };

  return { ...state, setAmount, setMethod, addRow, removeRow, reset };
}
