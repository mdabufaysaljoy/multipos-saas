import type { ReceiptStore } from './receipt';
import type { PosReturnSummary } from './domain';

/** Free-text medicine form; the server normalises it and derives its category. */
export type DosageForm = string;

export interface MedicineStock {
  onHand: number;
  /** Unexpired units: the only ones that can be sold. */
  sellable: number;
  expired: number;
  nearestExpiry: string | null;
}

export interface Medicine {
  _id: string;
  name: string;
  genericName: string;
  strength: string;
  dosageForm: DosageForm;
  manufacturer: string;
  containerType: string;
  packageSize: string;
  category: string;
  barcode: string;
  sellingPriceMinor: number;
  packQuantity: number;
  packPriceMinor: number;
  requiresPrescription: boolean;
  reorderLevel: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  stock?: MedicineStock;
}

export interface MedicineInput {
  name: string;
  genericName: string;
  strength: string;
  dosageForm: DosageForm;
  manufacturer: string;
  category?: string;
  containerType: string;
  packageSize: string;
  barcode: string;
  sellingPriceMinor: number;
  packQuantity: number;
  packPriceMinor: number;
  requiresPrescription: boolean;
  reorderLevel: number;
  isActive: boolean;
}

export interface MedicineBatch {
  _id: string;
  /** An id, or the medicine itself on list endpoints. */
  medicineId: string | { _id: string; name: string; genericName: string; strength: string; dosageForm: DosageForm } | null;
  batchNumber: string;
  expiryDate: string;
  quantityReceived: number;
  quantityOnHand: number;
  costPriceMinor: number;
  supplierName: string;
  receivedAt: string;
  receivedByNameSnapshot: string;
}

export interface MedicineDetail {
  medicine: Medicine;
  batches: MedicineBatch[];
}

export interface StockMovement {
  _id: string;
  medicineNameSnapshot: string;
  batchNumberSnapshot: string;
  type: 'receive' | 'sale' | 'void' | 'adjust' | 'write_off';
  quantity: number;
  balanceAfter: number;
  reason: string;
  referenceNumber: string;
  createdByNameSnapshot: string;
  createdAt: string;
}

export interface PharmacySaleLine {
  _id: string;
  medicineId: string;
  nameSnapshot: string;
  genericNameSnapshot: string;
  strengthSnapshot: string;
  dosageFormSnapshot: string;
  requiresPrescription: boolean;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
  allocations: { batchId: string; batchNumber: string; expiryDate: string; quantity: number; costPriceMinor: number }[];
  /** How much of this line has already come back. */
  returnedQuantity?: number;
}

/** The original dispensing replaced by this sale, printed on its receipt. */
export interface PharmacySaleExchange {
  returnId: string | null;
  returnNumber: string;
  originalSaleId: string;
  originalSaleNumber: string;
  creditMinor: number;
  returnedItems: {
    nameSnapshot: string;
    detailSnapshot: string;
    quantity: number;
    unitType: string;
    lineTotalMinor: number;
  }[];
}

export interface PharmacySale {
  _id: string;
  saleNumber: string;
  items: PharmacySaleLine[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  costMinor: number;
  paidMinor: number;
  changeMinor: number;
  payments: { method: string; amountMinor: number }[];
  prescription: { patientName: string; prescriberName: string; prescriptionNumber: string; note: string } | null;
  customerNameSnapshot: string;
  note: string;
  status: 'completed' | 'voided';
  /** Value returned against this sale, and whether nothing is left to return. */
  returnedTotalMinor?: number;
  fullyReturned?: boolean;
  exchange?: PharmacySaleExchange | null;
  soldAt: string;
  cashierNameSnapshot: string;
  voidedAt: string | null;
  voidedByNameSnapshot: string;
  voidReason: string;
}

export interface PharmacyExchangeInput {
  items: { saleItemId: string; quantity: number; restock: boolean }[];
  replacement: {
    items: { medicineId: string; quantity: number }[];
    payments: { method: string; amountMinor: number }[];
  };
  reason: string;
  idempotencyKey: string;
}

export interface PharmacyExchange {
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
  replayed?: boolean;
}

export interface PharmacyShiftReport {
  generatedAt: string;
  sales: { salesCount: number; itemsSold: number; grossSalesMinor: number; discountsMinor: number; netSalesMinor: number };
  byPaymentMethod: { method: string; amountMinor: number; count: number }[];
  returns: { count: number; amountMinor: number; cashMinor: number };
  voids: { sales: number; valueMinor: number };
  cash: { openingFloatMinor: number; cashSalesMinor: number; cashRefundsMinor: number; payInsMinor: number; payOutsMinor: number; expectedCashMinor: number; countedCashMinor: number | null; varianceMinor: number | null };
}

export interface PharmacyShift {
  _id: string;
  shiftNumber: string;
  status: 'open' | 'closed';
  openingFloatMinor: number;
  openingNote: string;
  openedAt: string;
  openedByNameSnapshot: string;
  cashMovements?: { _id: string; type: 'pay_in' | 'pay_out'; amountMinor: number; reason: string; at: string; byNameSnapshot: string }[];
  closedAt: string | null;
  closedByNameSnapshot: string;
  closingNote: string;
  countedCashMinor: number | null;
  expectedCashMinor: number | null;
  varianceMinor: number | null;
}

export interface PharmacyShiftDetail {
  shift: PharmacyShift;
  report: PharmacyShiftReport;
  store: ReceiptStore | null;
}

export interface PharmacyReceipt {
  sale: PharmacySale;
  store: ReceiptStore;
}

export interface AnalyticsRange {
  from: string;
  to: string;
  label: string;
  preset: string;
}

export interface VoidedSaleRow {
  _id: string;
  saleNumber: string;
  totalMinor: number;
  voidReason: string;
  voidedAt: string;
  voidedByNameSnapshot: string;
}

export interface StockBucket {
  units: number;
  costMinor: number;
}

export interface PharmacyReports {
  range: AnalyticsRange;
  totals: {
    salesCount: number;
    /** What was charged. */
    grossSalesMinor: number;
    returnCount: number;
    returnAmountMinor: number;
    /** What was kept: charged less refunded. */
    netSalesMinor: number;
    discountsMinor: number;
    costMinor: number;
    grossProfitMinor: number;
    marginBps: number;
    averageBasketMinor: number;
    prescriptionSales: number;
    prescriptionValueMinor: number;
  };
  trend: { date: string; salesCount: number; grossSalesMinor: number; returnAmountMinor: number; netSalesMinor: number; grossProfitMinor: number }[];
  medicines: {
    medicineId: string;
    name: string;
    strength: string;
    genericName: string;
    quantity: number;
    revenueMinor: number;
    costMinor: number;
    profitMinor: number;
    marginBps: number;
  }[];
  dosageForms: { dosageForm: string; quantity: number; revenueMinor: number }[];
  payments: { method: string; sales: number; amountMinor: number }[];
  discounts: { totalMinor: number; byStaff: { userId: string | null; name: string; sales: number; discountsMinor: number }[] };
  staff: { userId: string; name: string; sales: number; items: number; netSalesMinor: number; discountsMinor: number; grossProfitMinor: number; averageBasketMinor: number }[];
  /** What came back: money, units and the most recent of them. */
  returns: {
    count: number;
    units: number;
    amountMinor: number;
    costMinor: number;
    recent: PosReturnSummary[];
  };
  voids: { count: number; valueMinor: number; recent: VoidedSaleRow[] };
  writeOffs: { units: number; costMinor: number; byMedicine: { medicineId: string; name: string; units: number; costMinor: number }[] };
  expiry: { expired: StockBucket; within30: StockBucket; within60: StockBucket; within90: StockBucket };
  expiryBatches: { batchId: string; medicineId: string; name: string; strength: string; manufacturer: string; batchNumber: string; expiryDate: string; quantityOnHand: number; costMinor: number; daysToExpiry: number }[];
  inventory: { batches: number; units: number; costMinor: number; expiredUnits: number; sellableUnits: number };
  slowMovers: { medicineId: string; name: string; strength: string; units: number; stockCostMinor: number }[];
}

export interface PharmacyDashboardTotals {
  salesCount: number;
  totalMinor: number;
  discountMinor: number;
  averageSaleMinor: number;
  costMinor: number;
}

export interface PharmacyDashboard {
  range: { from: string; to: string; label: string; preset: string; bucket: 'hour' | 'day' | 'month' };
  /** `totalMinor` is what was charged; `netSalesMinor` is what was kept. */
  kpis: PharmacyDashboardTotals & { prescriptionSales: number; refundCount: number; refundedMinor: number; netSalesMinor: number; grossProfitMinor: number };
  /** The period of equal length just before the range, for comparison. */
  previous: PharmacyDashboardTotals;
  /** Stock is not a period: expiry and low stock describe the shelf right now. */
  expiringSoon: {
    batchId: string;
    medicineId: string | null;
    medicineName: string;
    strength: string;
    batchNumber: string;
    expiryDate: string;
    quantityOnHand: number;
  }[];
  expired: { batches: number; units: number; costMinor: number };
  stock: { batches: number; units: number; costMinor: number };
  trend: { bucket: string; salesCount: number; netSalesMinor: number; grossProfitMinor: number }[];
  payments: { method: string; sales: number; amountMinor: number }[];
  topMedicines: { medicineId: string; name: string; strength: string; quantity: number; revenueMinor: number }[];
  recentSales: { saleId: string; saleNumber: string; totalMinor: number; itemCount: number; cashierName: string; customerName: string; soldAt: string }[];
  lowStock: { medicineId: string; name: string; strength: string; reorderLevel: number; sellable: number }[];
}
