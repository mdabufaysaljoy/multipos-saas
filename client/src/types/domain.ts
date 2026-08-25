export const PAYMENT_METHODS = ['cash', 'bkash', 'nagad', 'bank', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  bkash: 'bKash',
  nagad: 'Nagad',
  bank: 'Bank',
  card: 'Card',
  other: 'Other',
};

export interface Category {
  _id: string;
  name: string;
  slug: string;
  description: string;
  isActive: boolean;
  productCount?: number;
  createdAt: string;
}

export interface VariantAttribute {
  name: string;
  value: string;
}

export interface ProductVariant {
  _id: string;
  productId: string;
  productNameSnapshot: string;
  name: string;
  attributes: VariantAttribute[];
  sku: string;
  barcode: string | null;
  sellingPriceMinor: number;
  costPriceMinor: number;
  stock: number;
  lowStockThreshold: number;
  isActive: boolean;
}

export interface ProductImage {
  url: string;
  key: string | null;
  isPrimary: boolean;
}

export interface ProductOption {
  name: string;
  values: string[];
}

export interface Product {
  _id: string;
  name: string;
  sku: string;
  categoryId: string | null;
  categoryNameSnapshot: string;
  description: string;
  brand: string;
  images: ProductImage[];
  options: ProductOption[];
  hasVariants: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  variants: ProductVariant[];
  variantCount?: number;
  totalStock?: number;
  minPriceMinor?: number;
  maxPriceMinor?: number;
  hasLowStock?: boolean;
}

/** Flattened sellable unit returned by the POS search endpoint. */
export interface PosVariant {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  attributes: VariantAttribute[];
  sku: string;
  barcode: string | null;
  brand: string;
  categoryId: string | null;
  categoryName: string;
  imageUrl: string | null;
  sellingPriceMinor: number;
  costPriceMinor: number;
  stock: number;
  lowStockThreshold: number;
}

export interface Customer {
  _id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  totalSpentMinor: number;
  orderCount: number;
  lastPurchaseAt: string | null;
  isActive: boolean;
  createdAt: string;
  recentSales?: Sale[];
}

export interface SaleItem {
  _id: string;
  productId: string;
  variantId: string;
  productNameSnapshot: string;
  variantNameSnapshot: string;
  skuSnapshot: string;
  brandSnapshot: string;
  categoryId: string | null;
  categoryNameSnapshot: string;
  unitPriceMinor: number;
  listPriceMinor: number;
  costPriceMinorSnapshot: number;
  quantity: number;
  lineDiscountMinor: number;
  lineTotalMinor: number;
  returnedQuantity: number;
}

export interface SalePayment {
  method: string;
  amountMinor: number;
  reference: string;
}

export interface Sale {
  _id: string;
  saleNumber: string;
  cashierId: string;
  cashierNameSnapshot: string;
  customerId: string | null;
  customerSnapshot: { name: string; phone: string; email: string } | null;
  items: SaleItem[];
  subtotalMinor: number;
  discountMinor: number;
  discountType: 'none' | 'fixed' | 'percent';
  discountValue: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  changeMinor: number;
  paymentMethod: string;
  /** Full tender breakdown; one entry per method for a split payment. */
  payments: SalePayment[];
  paymentStatus: string;
  status: 'completed' | 'cancelled';
  note: string;
  returnedTotalMinor: number;
  fullyReturned: boolean;
  soldAt: string;
  createdAt: string;
}

export interface StoreSettings {
  _id: string;
  name: string;
  code: string;
  logoUrl: string | null;
  phone: string;
  email: string;
  address: string;
  currency: string;
  invoicePrefix: string;
  returnPrefix: string;
  lowStockThreshold: number;
  paymentMethods: string[];
  receipt: {
    headerText: string;
    footerText: string;
    returnPolicy: string;
    showLogo: boolean;
    showCashier: boolean;
    paperWidthMm: 58 | 78 | 80;
  };
  tax: { enabled: boolean; label: string; rateBasisPoints: number; inclusive: boolean };
  isActive: boolean;
  isDefault: boolean;
}

export interface ReceiptPayload {
  sale: Sale;
  store: Pick<StoreSettings, 'name' | 'logoUrl' | 'phone' | 'email' | 'address' | 'currency' | 'receipt' | 'tax'>;
}

export interface ReturnItem {
  _id: string;
  saleItemId: string;
  productId: string;
  variantId: string;
  productNameSnapshot: string;
  variantNameSnapshot: string;
  skuSnapshot: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  restock: boolean;
}

export interface ReturnDoc {
  _id: string;
  returnNumber: string;
  saleId: string;
  saleNumberSnapshot: string;
  customerSnapshot: { name: string; phone: string } | null;
  items: ReturnItem[];
  totalMinor: number;
  reason: string;
  refundMethod: string;
  processedByNameSnapshot: string;
  returnedAt: string;
}

export interface ReturnableSale {
  sale: {
    id: string;
    saleNumber: string;
    soldAt: string;
    customerSnapshot: { name: string; phone: string } | null;
    cashierNameSnapshot: string;
    totalMinor: number;
    returnedTotalMinor: number;
    status: string;
  };
  items: {
    saleItemId: string;
    productId: string;
    variantId: string;
    productName: string;
    variantName: string;
    sku: string;
    unitPriceMinor: number;
    soldQuantity: number;
    returnedQuantity: number;
    returnableQuantity: number;
    lineTotalMinor: number;
  }[];
  fullyReturned: boolean;
}

export interface InventoryRow extends ProductVariant {}

export interface LedgerEntry {
  _id: string;
  productNameSnapshot: string;
  variantNameSnapshot: string;
  skuSnapshot: string;
  type: string;
  quantityChange: number;
  previousStock: number;
  newStock: number;
  reason: string;
  referenceType: string | null;
  referenceNumber: string;
  performedByNameSnapshot: string;
  createdAt: string;
}

export interface InventorySummary {
  totalUnits: number;
  stockValueMinor: number;
  retailValueMinor: number;
  variantCount: number;
  outOfStock: number;
  lowStock: number;
}

export interface StaffMember {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  roleId: string | null;
  roleName: string | null;
  extraPermissions: string[];
  deniedPermissions: string[];
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  effectivePermissions: string[];
}

export interface Role {
  _id: string;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
  isActive: boolean;
  staffCount?: number;
}

export interface PermissionGroup {
  group: string;
  label: string;
  permissions: { key: string; label: string; description: string }[];
}

export interface DashboardReport {
  range: { from: string; to: string; label: string; preset: string };
  summary: {
    totalSalesMinor: number;
    orderCount: number;
    itemCount: number;
    discountMinor: number;
    taxMinor: number;
    totalCostMinor: number;
    returnCount: number;
    returnedItems: number;
    returnAmountMinor: number;
    netSalesMinor: number;
    averageOrderValueMinor: number;
    grossProfitMinor: number;
  };
  trend: { bucket: string; totalMinor: number; orderCount: number; itemCount: number }[];
  topProducts: { productId: string; name: string; quantity: number; revenueMinor: number }[];
  topVariants: { variantId: string; productName: string; variantName: string; sku: string; quantity: number; revenueMinor: number }[];
  byCategory: { categoryId: string | null; name: string; quantity: number; revenueMinor: number }[];
  byPaymentMethod: { method: string; orderCount: number; totalMinor: number }[];
  byStaff: { cashierId: string; name: string; orderCount: number; totalMinor: number }[];
}

export interface SubscriptionPlan {
  _id: string;
  code: string;
  name: string;
  description: string;
  interval: 'monthly' | 'yearly';
  priceMinor: number;
  currency: string;
  trialDays: number;
  features: Record<string, boolean>;
  limits: Record<string, number>;
  isActive: boolean;
  sortOrder: number;
}

export interface Subscription {
  _id: string;
  planSnapshot: { code: string; name: string; interval: string; priceMinor: number; currency: string };
  status: string;
  startedAt: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  autoRenew: boolean;
  provider: string;
  notes: string;
  createdAt: string;
}
