import type { ReceiptStore } from './receipt';

export interface PosShift {
  _id: string;
  vertical: 'clothing' | 'supershop';
  shiftNumber: string;
  status: 'open' | 'closed';
  openingFloatMinor: number;
  openingNote: string;
  openedAt: string;
  openedByNameSnapshot: string;
  cashMovements?: {
    _id: string;
    type: 'pay_in' | 'pay_out';
    amountMinor: number;
    reason: string;
    at: string;
    byNameSnapshot: string;
  }[];
  closedAt: string | null;
  closedByNameSnapshot: string;
  closingNote: string;
  countedCashMinor: number | null;
  expectedCashMinor: number | null;
  varianceMinor: number | null;
}

export interface PosShiftReport {
  generatedAt: string;
  sales: {
    salesCount: number;
    itemsSold: number;
    grossSalesMinor: number;
    discountsMinor: number;
    netSalesMinor: number;
  };
  byPaymentMethod: { method: string; amountMinor: number; count: number }[];
  returns: { count: number; amountMinor: number; cashMinor: number };
  voids: { sales: number; valueMinor: number };
  cash: {
    openingFloatMinor: number;
    cashSalesMinor: number;
    cashRefundsMinor: number;
    payInsMinor: number;
    payOutsMinor: number;
    expectedCashMinor: number;
    countedCashMinor: number | null;
    varianceMinor: number | null;
  };
}

export interface PosShiftDetail {
  shift: PosShift;
  report: PosShiftReport;
  store: ReceiptStore | null;
}
