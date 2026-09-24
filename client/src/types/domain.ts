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
  /** Sold while the variant had no stock (permission `sales.sellOutOfStock`). Internal; not printed on receipts. */
  outOfStockOverride?: boolean;
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
  /** Present when this sale is the replacement side of an exchange. */
  exchange?: {
    returnId: string | null;
    returnNumber: string;
    creditMinor: number;
    returnedItems: { productNameSnapshot: string; variantNameSnapshot: string; quantity: number; lineTotalMinor: number }[];
  } | null;
  /** Present when a loyalty card was scanned. `discountMinor` above already includes `loyalty.discountMinor`. */
  loyalty?: SaleLoyalty | null;
}

export interface SaleLoyalty {
  membershipId: string;
  cardNumber: string;
  pointValueMinor: number;
  earnSpendMinor: number;
  pointsRedeemed: number;
  discountMinor: number;
  qualifyingMinor: number;
  pointsEarned: number;
  balanceAfter: number;
  pointsEarnedReversed: number;
  pointsRedeemedRestored: number;
}

/** The datasets and formats the server allows for data export. */
export interface ExportCatalog {
  datasets: { key: string; label: string; description: string; dated: boolean }[];
  formats: { key: 'csv' | 'xlsx' | 'json' | 'pdf'; label: string; description: string }[];
  limits: { rows: number; pdfRows: number };
}

export interface ExportJob {
  _id: string;
  type: string;
  format: string;
  filterSummary: string;
  status: 'completed' | 'failed';
  rowCount: number;
  byteSize: number;
  error: string;
  requestedByNameSnapshot: string;
  createdAt: string;
}

/** Supplier management (Clothing POS, Professional and Enterprise). */
export const SUPPLIER_TYPES = ['manufacturer', 'wholesaler', 'distributor', 'importer', 'local', 'other'] as const;
export type SupplierType = (typeof SUPPLIER_TYPES)[number];

export const PAYMENT_TERMS = ['cash', 'on_delivery', 'net_7', 'net_15', 'net_30', 'net_60', 'other'] as const;
export type PaymentTerm = (typeof PAYMENT_TERMS)[number];

export interface SupplierContact {
  name: string;
  designation: string;
  phone: string;
  altPhone: string;
  email: string;
}

export interface SupplierAddress {
  line1: string;
  line2: string;
  area: string;
  city: string;
  district: string;
  division: string;
  postalCode: string;
  country: string;
}

/** Only ever present on the detail view, and only for users who may edit suppliers. */
export interface SupplierBanking {
  accountName: string;
  accountNumber: string;
  bankName: string;
  branchName: string;
}

export interface Supplier {
  _id: string;
  code: string;
  name: string;
  type: SupplierType;
  contact: SupplierContact;
  phone: string;
  email: string;
  website: string;
  address: SupplierAddress;
  taxNumber: string;
  tradeLicense: string;
  banking?: SupplierBanking;
  paymentTerms: PaymentTerm;
  paymentTermsNote: string;
  notes: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The list row: no banking, no tax, no notes. */
export type SupplierListItem = Pick<Supplier, '_id' | 'code' | 'name' | 'type' | 'phone' | 'email' | 'isActive' | 'createdAt' | 'updatedAt'> & {
  contact: Pick<SupplierContact, 'name' | 'phone' | 'email'>;
};

export interface SupplierSummary {
  active: number;
  inactive: number;
  total: number;
  /** null when the plan sets no ceiling. */
  max: number | null;
  unlimited: boolean;
  remaining: number | null;
  /** True after a downgrade left more suppliers than the new plan allows. */
  overLimit: boolean;
  planName: string | null;
}

/** Bulk product import (Excel/CSV) - available on every plan. */
export interface ImportColumnSpec {
  field: string;
  label: string;
  required: boolean;
  aliases: string[];
  hint: string;
}

export interface ImportCatalog {
  columns: ImportColumnSpec[];
  limits: { maxRows: number; maxBytes: number };
  formats: string[];
}

export interface ImportRowError {
  rowNumber: number;
  productName: string;
  variantName: string;
  field: string;
  message: string;
}

export interface ImportPreview {
  importId: string;
  filename: string;
  format: 'xlsx' | 'csv';
  headerRow: number;
  mapping: { header: string; field: string | null; ignored: boolean }[];
  unmappedHeaders: string[];
  summary: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    blankRows: number;
    productsToCreate: number;
    variantsToCreate: number;
    categoriesToCreate: number;
  };
  missingCategories: string[];
  preview: {
    name: string;
    brand: string;
    category: string;
    variantCount: number;
    variants: { name: string; sku: string; barcode: string; sellingPriceMinor: number; stock: number }[];
  }[];
  errors: ImportRowError[];
  errorsTruncated: boolean;
  expiresAt: string | null;
}

export interface ImportResult {
  importId: string;
  status: 'completed' | 'failed';
  summary: {
    rowsProcessed: number;
    rowsImported: number;
    rowsFailed: number;
    rowsSkipped: number;
    productsCreated: number;
    variantsCreated: number;
    categoriesCreated: number;
  };
  failures: { productName: string; rowNumbers: number[]; message: string }[];
  stopped: string | null;
}

export interface ProductImportJob {
  _id: string;
  filename: string;
  format: 'xlsx' | 'csv';
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  totalRows: number;
  validRows: number;
  invalidRows: number;
  productsCreated: number;
  variantsCreated: number;
  rowsImported: number;
  rowsFailed: number;
  categoriesCreated: number;
  error: string;
  requestedByNameSnapshot: string;
  createdAt: string;
}

/** Barcode label printing sizes (store settings). */
export interface LabelSettings {
  productWidthMm: 38 | 48 | 58;
  loyaltyCardWidthMm: 48 | 58 | 85;
  /** sheet = normal page / A4 sticker sheet; roll = label printer, page is one label wide. */
  paper: 'sheet' | 'roll';
}

export const DEFAULT_LABEL_SETTINGS: LabelSettings = { productWidthMm: 38, loyaltyCardWidthMm: 85, paper: 'sheet' };

/** Store loyalty rules, all in minor units. */
export interface LoyaltySettings {
  enabled: boolean;
  /** Spend that earns one point (10000 = ৳100). */
  earnSpendMinor: number;
  /** Discount value of one point (100 = ৳1.00). */
  pointValueMinor: number;
  membershipFeeMinor: number;
}

/** What the till gets from scanning a card. */
export interface LoyaltyLookup {
  id: string;
  cardNumber: string;
  status: 'active' | 'inactive';
  pointsBalance: number;
  pointValueMinor: number;
  valueMinor: number;
  earnSpendMinor: number;
  customer: { id: string; name: string; phone: string; email: string } | null;
}

export interface LoyaltyMember extends Omit<LoyaltyLookup, 'earnSpendMinor'> {
  barcode: string;
  pointsEarnedTotal: number;
  pointsRedeemedTotal: number;
  membershipFeeMinor: number;
  feePayments: { method: string; amountMinor: number; reference: string }[];
  feeChangeMinor: number;
  issuedAt: string;
  issuedByNameSnapshot: string;
  statusChangedAt: string | null;
  statusReason: string;
  replayed?: boolean;
}

export interface LoyaltyTransaction {
  _id: string;
  type: 'earn' | 'redeem' | 'redeem_reversed' | 'earn_reversed' | 'redeem_restored' | 'adjustment';
  points: number;
  balanceBefore: number;
  balanceAfter: number;
  saleNumber: string;
  returnNumber: string;
  reason: string;
  performedByNameSnapshot: string;
  createdAt: string;
}

export interface LoyaltySummary {
  totalMembers: number;
  activeCards: number;
  pointsIssued: number;
  pointsRedeemed: number;
  pointsOutstanding: number;
  membershipFeesMinor: number;
}

export interface StoreSettings {
  _id: string;
  name: string;
  code: string;
  /** Shown in the POS UI. */
  logoUrl: string | null;
  /** Printed on receipts - a separate image from the UI logo. */
  receiptLogoUrl: string | null;
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
    paperWidthMm: 48 | 58 | 78 | 80;
  };
  tax: { enabled: boolean; label: string; rateBasisPoints: number; inclusive: boolean };
  loyalty?: LoyaltySettings;
  labels?: LabelSettings;
  isActive: boolean;
  isDefault: boolean;
}

export interface ReceiptPayload {
  sale: Sale;
  store: Pick<
    StoreSettings,
    'name' | 'logoUrl' | 'receiptLogoUrl' | 'phone' | 'email' | 'address' | 'currency' | 'receipt' | 'tax'
  >;
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
  exchange?: {
    saleId: string;
    saleNumber: string;
    refundableMinor: number;
    replacementSubtotalMinor: number;
    replacementTotalMinor: number;
    extraPayableMinor: number;
  } | null;
  /** Returned by the create call for an exchange. */
  replacementSale?: Sale | null;
  /** Points effect of the return; its value was deducted from the money refund. */
  loyalty?: { membershipId: string; pointsEarnedReversed: number; pointsRedeemedRestored: number; valueMinor: number } | null;
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
    subtotalMinor?: number;
    status: string;
    loyalty?: Pick<SaleLoyalty, 'cardNumber' | 'pointValueMinor' | 'earnSpendMinor' | 'pointsRedeemed' | 'qualifyingMinor' | 'pointsEarned' | 'pointsEarnedReversed' | 'pointsRedeemedRestored'> | null;
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

export type InventoryRow = ProductVariant;

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
  storeId?: string | null;
  storeAccess?: string[];
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

/** Someone from another workspace of the same account, working in this one. */
export interface WorkspaceMemberRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  phone: string;
  homeWorkspace: { id: string; name: string } | null;
  roleId: string | null;
  roleName: string | null;
  storeId: string | null;
  storeAccess: string[];
  extraPermissions: string[];
  deniedPermissions: string[];
  isActive: boolean;
  accountActive: boolean;
  lastLoginAt: string | null;
  addedByNameSnapshot: string;
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
  /** Upgrade ladder position; higher is a better plan. */
  tier: number;
  /** The POS product this plan is sold to; null/absent means every POS type. */
  posProductCode?: string | null;
  /** Catalog plan (starter / professional / enterprise) this SKU is sold as; null for a bespoke plan. */
  catalogPlanCode?: string | null;
  billingCycle?: 'monthly' | 'annual';
  /** Shown on the pricing page (admin data; public plans only reach customers). */
  isPublic?: boolean;
  /** The vertical `features` and `limits` were resolved for (public catalogue). */
  vertical?: 'clothing' | 'restaurant' | 'pharmacy' | 'supershop' | 'grocery';
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


// ---------------------------------------------------------------- reports

export interface ReportRange {
  from: string;
  to: string;
  label: string;
  preset?: string;
}

export interface SalesProfitReport {
  range: ReportRange;
  grossSalesMinor: number;
  discountsMinor: number;
  returnAmountMinor: number;
  taxMinor: number;
  cogsMinor: number;
  netSalesMinor: number;
  netProfitMinor: number;
  /** 1% = 100 */
  marginBasisPoints: number;
  invoiceCount: number;
  itemCount: number;
  returnCount: number;
  returnedItems: number;
  averageOrderValueMinor: number;
  trend: { bucket: string; totalMinor: number; orderCount: number; itemCount: number }[];
  /** The same figures for the preceding period of equal length. */
  previous: {
    range: { from: string; to: string };
    grossSalesMinor: number;
    discountsMinor: number;
    returnAmountMinor: number;
    netSalesMinor: number;
    cogsMinor: number;
    netProfitMinor: number;
    marginBasisPoints: number;
    invoiceCount: number;
    itemCount: number;
    averageOrderValueMinor: number;
  };
}

export interface BreakdownRow {
  id: string | null;
  label: string;
  sub?: string;
  sku?: string;
  quantity: number;
  grossQuantity: number;
  returnedQuantity: number;
  revenueMinor: number;
  costMinor: number;
  profitMinor: number;
}

export interface BreakdownReport {
  range: ReportRange;
  dimension: string;
  rows: BreakdownRow[];
}

export interface StaffReportRow {
  id: string;
  label: string;
  orderCount: number;
  revenueMinor: number;
  itemCount: number;
  profitMinor: number;
}

export interface ReturnReport {
  range: ReportRange;
  summary: { count: number; amountMinor: number; items: number };
  byProduct: { id: string; label: string; sub: string; sku: string; quantity: number; amountMinor: number }[];
  byReason: { reason: string; count: number; amountMinor: number }[];
}

export interface InventoryReport {
  summary: {
    units: number;
    costValueMinor: number;
    retailValueMinor: number;
    variants: number;
    lowStockCount: number;
    outOfStockCount: number;
  };
  lowStock: { _id: string; productNameSnapshot: string; name: string; sku: string; stock: number; lowStockThreshold: number; sellingPriceMinor: number }[];
  outOfStock: { _id: string; productNameSnapshot: string; name: string; sku: string; stock: number; sellingPriceMinor: number }[];
  topValue: { _id: string; productNameSnapshot: string; name: string; sku: string; stock: number; valueMinor: number }[];
}

export interface CustomerReport {
  range: ReportRange;
  rows: { id: string; label: string; sub: string; orderCount: number; spentMinor: number; itemCount: number }[];
  walkIn: { count: number; totalMinor: number };
  summary: { customers: number; repeatCustomers: number; orders: number; totalMinor: number; averageSpendMinor: number };
}

export interface OverviewReport {
  range: ReportRange;
  kpis: {
    salesMinor: number;
    grossSalesMinor: number;
    orderCount: number;
    itemCount: number;
    /** Null when the plan does not include Advanced Analytics. */
    profitMinor: number | null;
    returnCount: number;
    returnAmountMinor: number;
    averageOrderValueMinor: number;
    stockValueMinor: number;
    stockUnits: number;
    lowStockCount: number;
    outOfStockCount: number;
  };
  trend: { bucket: string; totalMinor: number; orderCount: number; itemCount: number }[];
  topProducts: { productId: string; name: string; quantity: number; revenueMinor: number }[];
  lowStock: InventoryReport['lowStock'];
  recentSales: {
    id: string;
    saleNumber: string;
    soldAt: string;
    totalMinor: number;
    paymentMethod: string;
    cashier: string;
    customer: string | null;
    itemCount: number;
  }[];
  payments: { method: string; amountMinor: number; count: number }[];
}


export interface BranchReportRow {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  orders: number;
  items: number;
  revenueMinor: number;
  returnCount: number;
  returnAmountMinor: number;
  netSalesMinor: number;
  profitMinor: number;
  stockUnits: number;
  stockValueMinor: number;
}

export interface BranchReport {
  range: ReportRange;
  rows: BranchReportRow[];
  totals: {
    orders: number;
    netSalesMinor: number;
    profitMinor: number;
    returnAmountMinor: number;
    stockValueMinor: number;
  };
}

export interface UpgradeRequest {
  _id: string;
  planSnapshot: { code: string; name: string; interval: string; priceMinor: number; currency: string };
  currentPlanCodeSnapshot: string | null;
  paymentMethod: string;
  amountMinor: number;
  senderNumber: string;
  transactionId: string;
  note: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  reviewNote: string;
  reviewedAt: string | null;
  createdAt: string;
}


export interface WalletTransaction {
  _id: string;
  type: 'credit' | 'debit' | 'refund' | 'adjustment';
  amountMinor: number;
  balanceBeforeMinor: number;
  balanceAfterMinor: number;
  reason: string;
  referenceType: string | null;
  performedByNameSnapshot: string;
  createdAt: string;
}

export interface TopUp {
  _id: string;
  amountMinor: number;
  currency: string;
  paymentMethod: string;
  transactionId: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  reviewNote: string;
  createdAt: string;
  /** Set once the top-up is approved and its receipt issued. */
  receipt?: { id: string; number: string | null } | null;
}


export interface SmsEstimate {
  recipients: number;
  segments: number;
  encoding: 'GSM7' | 'UCS2';
  characters: number;
  perSmsCostMinor: number;
  totalCostMinor: number;
}

/**
 * Two independent reasons a channel may be unusable, and the UI must tell them
 * apart: `includedInPlan` is a billing question the customer can act on,
 * `providerConfigured` is a server setup question they cannot. `available` is
 * simply both, and governs SENDING only - never whether a campaign can be
 * written.
 */
export interface MessagingChannelStatus {
  available: boolean;
  includedInPlan: boolean;
  providerConfigured: boolean;
  provider: string | null;
  displayName: string | null;
}

export interface MessagingStatus {
  sms: MessagingChannelStatus & {
    perSegmentCostMinor: number;
    providers: { name: string; displayName: string; configured: boolean }[];
  };
  email: MessagingChannelStatus & { perEmailCostMinor: number };
  planName: string | null;
  usage: { sent: number; failed: number; totalCostMinor: number; totalSegments: number };
}

export interface SmsMessage {
  _id: string;
  recipient: string;
  message: string;
  segments: number;
  encoding: string;
  costMinor: number;
  status: 'queued' | 'sent' | 'failed';
  error: string | null;
  sentAt: string | null;
  sentByNameSnapshot: string;
  createdAt: string;
}

export interface SmsCampaign {
  _id: string;
  name: string;
  message: string;
  segments: number;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  estimatedCostMinor: number;
  actualCostMinor: number;
  status: string;
  createdAt: string;
  createdByNameSnapshot: string;
}


export interface LimitBreach {
  resource: string;
  /** Human label, e.g. "branches". */
  label: string;
  current: number;
  limit: number;
  excess: number;
  /** What the owner must do, e.g. "Remove or deactivate 2 branches". */
  action: string;
}

export interface PlanOption {
  planId: string;
  code: string;
  name: string;
  interval: 'monthly' | 'yearly';
  tier: number;
  priceMinor: number;
  currency: string;
  features: Record<string, boolean>;
  limits: Record<string, number>;
  /** current | renewal | upgrade | cycle-change | cycle-downgrade | downgrade */
  kind: string;
  /** Catalog terms for buying or scheduling this plan; null for a bespoke plan. */
  catalogPlanCode?: string | null;
  billingCycle?: 'monthly' | 'annual';
  allowedDirect: boolean;
  reason: string;
  breaches: LimitBreach[];
}

export interface PlanOptionsResponse {
  currentPlanCode: string | null;
  usage: { branches: number; staff: number; products: number };
  options: PlanOption[];
}


export interface WalletBreakdown {
  balanceMinor: number;
  currency: string;
  totalCreditsMinor: number;
  totalRefundsMinor: number;
  /** Net of refunds. */
  totalDebitsMinor: number;
  grossDebitsMinor: number;
  services: { service: string; label: string; amountMinor: number }[];
}
