import type { ReceiptStore } from './receipt';

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
    netSalesMinor: number;
    discountsMinor: number;
    vatMinor: number;
    costMinor: number;
    grossProfitMinor: number;
    marginBps: number;
    averageBasketMinor: number;
    averageLines: number;
  };
  trend: { date: string; salesCount: number; netSalesMinor: number; vatMinor: number; grossProfitMinor: number }[];
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
  kpis: ShopDashboardTotals;
  /** The period of equal length just before the range, for comparison. */
  previous: ShopDashboardTotals;
  topProducts: { productId: string; name: string; unitType: ShopUnitType; quantity: number; totalMinor: number }[];
  /** Stock is not a period: these describe the shelf right now. */
  lowStock: { productId: string; name: string; unitType: ShopUnitType; reorderLevel: number; quantityOnHand: number }[];
  lowStockCount: number;
}
