import type { ReceiptStore } from './receipt';
import type { PosReturnSummary } from './domain';

/** Restaurant POS vertical. Kept apart from the Clothing domain types on purpose. */

export interface MenuItem {
  _id: string;
  name: string;
  category: string;
  description: string;
  priceMinor: number;
  isAvailable: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface DiningTable {
  _id: string;
  name: string;
  seats: number;
  isActive: boolean;
  openOrderId: string | null;
  openOrderNumber: string | null;
  openOrderTotalMinor: number | null;
}

export interface RestaurantOrderLine {
  _id: string;
  menuItemId: string;
  nameSnapshot: string;
  categorySnapshot: string;
  unitPriceMinor: number;
  quantity: number;
  note: string;
  lineTotalMinor: number;
  /** How many of this line the kitchen already has. */
  sentQuantity?: number;
  /** How much of this line has been refunded. */
  returnedQuantity?: number;
  /** Set when a line the kitchen had was removed; it stays at quantity 0. */
  voidedAt?: string | null;
}

export interface KitchenTicketLine {
  lineId: string;
  nameSnapshot: string;
  /** Change since the previous ticket: positive to make, negative to void. */
  quantity: number;
  note: string;
}

export interface KitchenTicket {
  _id: string;
  ticketNumber: string;
  lines: KitchenTicketLine[];
  status: 'pending' | 'ready' | 'void';
  createdAt: string;
  createdByNameSnapshot: string;
  readyAt: string | null;
  readyByNameSnapshot: string;
}

/** A ticket in the kitchen queue, with the order it belongs to. */
export interface KitchenQueueTicket extends KitchenTicket {
  orderId: string;
  orderNumber: string;
  type: RestaurantOrderType;
  tableNameSnapshot: string;
  orderNote: string;
}

/** The shared receipt branch; kept under its original name for existing callers. */
export type PrintStore = ReceiptStore;

export interface RestaurantReceiptPayload {
  kind: 'bill' | 'receipt';
  order: RestaurantOrder;
  store: PrintStore;
}

export interface KitchenTicketPayload {
  ticket: KitchenTicket;
  order: Pick<RestaurantOrder, '_id' | 'orderNumber' | 'type' | 'tableNameSnapshot' | 'note'>;
  store: PrintStore;
}

export type RestaurantOrderType = 'dine_in' | 'takeaway';
export type RestaurantOrderStatus = 'open' | 'paid' | 'cancelled';

export interface RestaurantOrder {
  _id: string;
  orderNumber: string;
  type: RestaurantOrderType;
  tableId: string | null;
  tableNameSnapshot: string;
  customerId: string | null;
  customerNameSnapshot: string;
  items: RestaurantOrderLine[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  paidMinor: number;
  changeMinor: number;
  payments: { method: string; amountMinor: number }[];
  tickets?: KitchenTicket[];
  status: RestaurantOrderStatus;
  /** Money refunded against this order, and whether nothing is left to refund. */
  returnedTotalMinor?: number;
  fullyReturned?: boolean;
  note: string;
  rev: number;
  openedByNameSnapshot: string;
  paidAt: string | null;
  shiftId?: string | null;
  cancelReason: string;
  createdAt: string;
}

export interface RestaurantDashboard {
  range: { from: string; to: string; label: string; preset: string; bucket: 'hour' | 'day' | 'month' };
  kpis: {
    revenueMinor: number;
    /** What was kept: charged less refunded. */
    netRevenueMinor: number;
    refundCount: number;
    refundedMinor: number;
    paidOrders: number;
    averageOrderMinor: number;
    itemsSold: number;
    discountsMinor: number;
    cancelledOrders: number;
  };
  previous: { revenueMinor: number; paidOrders: number; averageOrderMinor: number };
  live: { openOrders: number; openOrdersValueMinor: number; tables: number; occupiedTables: number };
  trend: { bucket: string; revenueMinor: number; orders: number }[];
  byPaymentMethod: { method: string; amountMinor: number; count: number }[];
  byType: { type: RestaurantOrderType; orders: number; revenueMinor: number }[];
  topItems: { menuItemId: string; name: string; quantity: number; revenueMinor: number }[];
  byStaff: { userId: string | null; name: string; orders: number; revenueMinor: number }[];
  recentOrders: Pick<RestaurantOrder, '_id' | 'orderNumber' | 'type' | 'tableNameSnapshot' | 'totalMinor' | 'status' | 'createdAt'>[];
}

// ---------------------------------------------------------------- shifts

export interface CashMovement {
  _id: string;
  type: 'pay_in' | 'pay_out';
  amountMinor: number;
  reason: string;
  at: string;
  byNameSnapshot: string;
}

export interface RestaurantShift {
  _id: string;
  shiftNumber: string;
  status: 'open' | 'closed';
  openingFloatMinor: number;
  openingNote: string;
  openedAt: string;
  openedByNameSnapshot: string;
  cashMovements?: CashMovement[];
  closedAt: string | null;
  closedByNameSnapshot: string;
  closingNote: string;
  countedCashMinor: number | null;
  expectedCashMinor: number | null;
  varianceMinor: number | null;
}

/** The Z-report: live while the shift is open, frozen once it closes. */
export interface ShiftReport {
  generatedAt: string;
  sales: { paidOrders: number; itemsSold: number; grossSalesMinor: number; discountsMinor: number; netSalesMinor: number };
  byPaymentMethod: { method: string; amountMinor: number; count: number }[];
  byType: { type: RestaurantOrderType; orders: number; netSalesMinor: number }[];
  cancelled: { orders: number; valueMinor: number };
  voids: { lines: number; quantity: number; valueMinor: number };
  openOrders: { orders: number; valueMinor: number };
  cash: {
    openingFloatMinor: number;
    cashSalesMinor: number;
    payInsMinor: number;
    payOutsMinor: number;
    expectedCashMinor: number;
    countedCashMinor: number | null;
    varianceMinor: number | null;
  };
}

export interface ShiftPayload {
  shift: RestaurantShift;
  report: ShiftReport;
  store: PrintStore;
}

export interface RestaurantReports {
  range: { from: string; to: string; label: string; preset: string };
  totals: {
    paidOrders: number;
    /** What was charged. */
    grossSalesMinor: number;
    returnCount: number;
    returnAmountMinor: number;
    /** What was kept: charged less refunded. */
    netSalesMinor: number;
    discountsMinor: number;
    unshiftedSalesMinor: number;
  };
  menu: { menuItemId: string; name: string; category: string; quantity: number; orders: number; revenueMinor: number }[];
  categories: { category: string; quantity: number; revenueMinor: number }[];
  /** Money taken by method, cash net of the change handed back. */
  payments: { method: string; orders: number; amountMinor: number }[];
  /** What was refunded: money, units and the most recent of them. */
  returns: { count: number; units: number; amountMinor: number; recent: PosReturnSummary[] };
  voids: {
    lines: number;
    quantity: number;
    valueMinor: number;
    byItem: { menuItemId: string; name: string; lines: number; quantity: number; valueMinor: number }[];
  };
  cancellations: {
    orders: number;
    valueMinor: number;
    recent: {
      _id: string;
      orderNumber: string;
      type: RestaurantOrderType;
      tableNameSnapshot: string;
      subtotalMinor: number;
      cancelReason: string;
      cancelledAt: string;
      openedByNameSnapshot: string;
    }[];
  };
  discounts: { totalMinor: number; byStaff: { userId: string | null; name: string; orders: number; discountsMinor: number }[] };
  kitchen: {
    tickets: number;
    averagePrepSeconds: number;
    slowestPrepSeconds: number;
    byHour: { hour: string; tickets: number; averagePrepSeconds: number }[];
  };
  shifts: { closed: number; totalVarianceMinor: number; shortShifts: number; list: RestaurantShift[] };
}

export interface RestaurantSummary {
  from: string;
  to: string;
  paidOrders: number;
  revenueMinor: number;
  discountsMinor: number;
  averageOrderMinor: number;
  openOrders: number;
  byPaymentMethod: { method: string; amountMinor: number; count: number }[];
  topItems: { menuItemId: string; name: string; quantity: number; revenueMinor: number }[];
}
