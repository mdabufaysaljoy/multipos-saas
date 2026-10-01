import type { ReceiptStore } from './receipt';
import type { PosReturnSummary } from './domain';

/** Restaurant POS vertical. Kept apart from the Clothing domain types on purpose. */

/**
 * One size or set of a dish: 8 / 10 / 12 inch, Quarter / Half / Full.
 *
 * A variant answers "WHICH version?" - exactly one is chosen and its price
 * REPLACES the dish's own. An add-on answers "what EXTRA?" - several may be
 * chosen and each price is added on top.
 */
export interface MenuItemVariant {
  _id: string;
  name: string;
  priceMinor: number;
  sku: string;
  isAvailable: boolean;
  sortOrder: number;
}

/**
 * One extra AS OFFERED ON ONE DISH: Extra cheese +80, Extra sauce +30.
 *
 * The name and price are this dish's copy, so the same extra may cost
 * different amounts on different dishes. `addOnId` points at the workspace's
 * reusable list when it was picked from there.
 */
export interface MenuAddOnOption {
  addOnId?: string | null;
  _id: string;
  name: string;
  priceMinor: number;
  isAvailable: boolean;
  sortOrder: number;
}

/** Extras offered together, with how many of them a line may take. */
export interface MenuAddOnGroup {
  _id: string;
  name: string;
  /** 1 or more makes the group a required choice. */
  minSelect: number;
  maxSelect: number;
  options: MenuAddOnOption[];
  sortOrder: number;
}

export interface MenuItem {
  _id: string;
  name: string;
  category: string;
  description: string;
  /** What a dish with no variants costs; the fallback when it has them. */
  priceMinor: number;
  variants: MenuItemVariant[];
  addOnGroups: MenuAddOnGroup[];
  isAvailable: boolean;
  sortOrder: number;
  createdAt: string;
}

/** A reusable extra, defined once for the whole workspace. */
export interface MenuAddOnRow {
  id: string;
  name: string;
  slug: string;
  /** What it usually costs; a dish may charge something else. */
  defaultPriceMinor: number;
  isActive: boolean;
  sortOrder: number;
  itemCount: number;
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

/** An extra carried by a line, at the price it was charged. */
export interface RestaurantOrderLineAddOn {
  optionId: string;
  groupNameSnapshot: string;
  nameSnapshot: string;
  priceMinor: number;
}

export interface RestaurantOrderLine {
  _id: string;
  menuItemId: string;
  nameSnapshot: string;
  categorySnapshot: string;
  /** The size chosen. Null for a dish with no variants. */
  variantId?: string | null;
  variantNameSnapshot?: string;
  addOns?: RestaurantOrderLineAddOn[];
  /** What ONE costs, all in: the variant (or base) price plus every add-on. */
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
  /** 'pending' when sent, 'void' when the order is cancelled. */
  status: 'pending' | 'ready' | 'void';
  createdAt: string;
  createdByNameSnapshot: string;
  /** Only ever set by the kitchen screen that used to exist; kept for history. */
  readyAt: string | null;
  readyByNameSnapshot: string;
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
