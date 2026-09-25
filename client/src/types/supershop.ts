import type { ReceiptStore } from './receipt';
import type { PosReturnSummary } from './domain';

/** `each`: quantity in pieces, price per piece. `weight`: quantity in grams, price per kg. */
export type ShopUnitType = 'each' | 'weight';

export interface ShopStock {
  /** Pieces, or grams for weighed goods. */
  quantityOnHand: number;
  /** Average cost per piece or per kg. */
  costPriceMinor: number;
}

export interface ShopProduct {
  _id: string;
  name: string;
  brand: string;
  category: string;
  barcode: string;
  unitType: ShopUnitType;
  /** VAT included; per piece or per kg. */
  priceMinor: number;
  vatRateBps: number;
  reorderLevel: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  stock?: ShopStock;
}

export interface ShopProductInput {
  name: string;
  brand: string;
  category: string;
  barcode: string;
  unitType: ShopUnitType;
  priceMinor: number;
  vatRateBps: number;
  reorderLevel: number;
  isActive: boolean;
}

export interface ShopMovement {
  _id: string;
  productNameSnapshot: string;
  unitType: ShopUnitType;
  type: 'receive' | 'sale' | 'void' | 'adjust' | 'write_off';
  quantity: number;
  balanceAfter: number;
  unitCostMinor: number | null;
  reason: string;
  referenceNumber: string;
  createdByNameSnapshot: string;
  createdAt: string;
}

/** What the branch holds right now: the cards above the inventory screen. */
export interface ShopInventorySummary {
  productCount: number;
  /** At weighted average cost, and at the shelf price. */
  stockValueMinor: number;
  retailValueMinor: number;
  outOfStock: number;
  lowStock: number;
}

export interface ShopProductDetail {
  product: ShopProduct;
  movements: ShopMovement[];
}

export interface ShopSaleLine {
  _id: string;
  productId: string;
  nameSnapshot: string;
  brandSnapshot: string;
  barcodeSnapshot: string;
  unitType: ShopUnitType;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
  vatRateBps: number;
  vatMinor: number;
  /** How much of this line has already come back. */
  returnedQuantity?: number;
}

/** What an exchange replaced, carried on the replacement sale for its receipt. */
export interface ShopSaleExchange {
  returnId: string | null;
  returnNumber: string;
  originalSaleId: string;
  originalSaleNumber: string;
  /** Refund value of the returned goods, applied here instead of paid out. */
  creditMinor: number;
  returnedItems: { nameSnapshot: string; detailSnapshot: string; quantity: number; unitType: string; lineTotalMinor: number }[];
}

export interface ShopSale {
  _id: string;
  saleNumber: string;
  items: ShopSaleLine[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  vatMinor: number;
  paidMinor: number;
  changeMinor: number;
  payments: { method: string; amountMinor: number }[];
  customerNameSnapshot: string;
  status: 'completed' | 'voided';
  /** Value returned against this sale, and whether nothing is left to return. */
  returnedTotalMinor?: number;
  fullyReturned?: boolean;
  /** Present only on the REPLACEMENT side of an exchange. */
  exchange?: ShopSaleExchange | null;
  soldAt: string;
  cashierNameSnapshot: string;
  voidedAt: string | null;
  voidedByNameSnapshot: string;
  voidReason: string;
}

export interface ShopReceipt {
  sale: ShopSale;
  store: ReceiptStore;
}

export interface ShopReports {
  range: { from: string; to: string; label: string; preset: string };
  totals: {
    salesCount: number;
    /** What was charged. */
    grossSalesMinor: number;
    returnCount: number;
    returnAmountMinor: number;
    /** What was kept: charged less refunded. */
    netSalesMinor: number;
    discountsMinor: number;
    vatMinor: number;
    costMinor: number;
    grossProfitMinor: number;
    marginBps: number;
    averageBasketMinor: number;
    averageLines: number;
  };
  trend: { date: string; salesCount: number; grossSalesMinor: number; returnAmountMinor: number; netSalesMinor: number; vatMinor: number; grossProfitMinor: number }[];
  products: {
    productId: string;
    name: string;
    unitType: ShopUnitType;
    quantity: number;
    revenueMinor: number;
    vatMinor: number;
    costMinor: number;
    profitMinor: number;
    marginBps: number;
  }[];
  departments: { department: string; lines: number; revenueMinor: number; profitMinor: number }[];
  vatRates: { vatRateBps: number; lines: number; grossMinor: number; vatMinor: number; netOfVatMinor: number }[];
  hours: { hour: string; salesCount: number; netSalesMinor: number }[];
  payments: { method: string; sales: number; amountMinor: number }[];
  discounts: { totalMinor: number; byStaff: { userId: string | null; name: string; sales: number; discountsMinor: number }[] };
  /** What came back: money, units and the most recent of them. */
  returns: {
    count: number;
    units: number;
    amountMinor: number;
    costMinor: number;
    recent: PosReturnSummary[];
  };
  voids: {
    count: number;
    valueMinor: number;
    recent: { _id: string; saleNumber: string; totalMinor: number; voidReason: string; voidedAt: string; voidedByNameSnapshot: string }[];
  };
  writeOffs: { costMinor: number; byProduct: { productId: string; name: string; unitType: ShopUnitType; quantity: number; costMinor: number }[] };
  deadStock: { productId: string; name: string; unitType: ShopUnitType; quantityOnHand: number; stockCostMinor: number }[];
}

export interface ShopDashboardTotals {
  salesCount: number;
  totalMinor: number;
  vatMinor: number;
  discountMinor: number;
  grossProfitMinor: number;
  averageSaleMinor: number;
}

export interface ShopDashboard {
  range: { from: string; to: string; label: string; preset: string; bucket: 'hour' | 'day' | 'month' };
  /** `totalMinor` is what was charged; `netSalesMinor` is what was kept. */
  kpis: ShopDashboardTotals & { refundCount: number; refundedMinor: number; netSalesMinor: number };
  /** The period of equal length just before the range, for comparison. */
  previous: ShopDashboardTotals;
  topProducts: { productId: string; name: string; unitType: ShopUnitType; quantity: number; totalMinor: number }[];
  /** Stock is not a period: these describe the shelf right now. */
  lowStock: { productId: string; name: string; unitType: ShopUnitType; reorderLevel: number; quantityOnHand: number }[];
  lowStockCount: number;
}


/** What the till sends to exchange goods. No prices: the server values both sides. */
export interface ShopExchangeInput {
  items: { saleItemId: string; quantity: number; restock: boolean }[];
  replacement: {
    items: { productId: string; quantity: number }[];
    /** Empty when the replacement costs exactly what came back. */
    payments: { method: string; amountMinor: number }[];
  };
  reason: string;
  /** Makes a double submission return the first exchange instead of a second one. */
  idempotencyKey: string;
}

/** The return an exchange wrote, with the replacement sale it paid for. */
export interface ShopExchange {
  _id: string;
  returnNumber: string;
  saleNumberSnapshot: string;
  totalMinor: number;
  returnedAt: string;
  exchange: {
    saleId: string;
    saleNumber: string;
    refundableMinor: number;
    replacementSubtotalMinor: number;
    replacementTotalMinor: number;
    extraPayableMinor: number;
  } | null;
  replacementSale?: { saleId: string; saleNumber: string; totalMinor: number; paidMinor: number; changeMinor: number };
  /** True when this response replayed an exchange that had already happened. */
  replayed?: boolean;
}
