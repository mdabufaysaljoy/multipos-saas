import type { ReceiptStore } from './receipt';

export type DosageForm =
  | 'tablet'
  | 'capsule'
  | 'syrup'
  | 'suspension'
  | 'injection'
  | 'cream'
  | 'ointment'
  | 'drops'
  | 'inhaler'
  | 'powder'
  | 'other';

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
  category: string;
  barcode: string;
  sellingPriceMinor: number;
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
  category: string;
  barcode: string;
  sellingPriceMinor: number;
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
  soldAt: string;
  cashierNameSnapshot: string;
  voidedAt: string | null;
  voidedByNameSnapshot: string;
  voidReason: string;
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
    netSalesMinor: number;
    discountsMinor: number;
    costMinor: number;
    grossProfitMinor: number;
    marginBps: number;
    averageBasketMinor: number;
    prescriptionSales: number;
    prescriptionValueMinor: number;
  };
  trend: { date: string; salesCount: number; netSalesMinor: number; grossProfitMinor: number }[];
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
  voids: { count: number; valueMinor: number; recent: VoidedSaleRow[] };
  writeOffs: { units: number; costMinor: number; byMedicine: { medicineId: string; name: string; units: number; costMinor: number }[] };
  expiry: { expired: StockBucket; within30: StockBucket; within60: StockBucket; within90: StockBucket };
  slowMovers: { medicineId: string; name: string; strength: string; units: number; stockCostMinor: number }[];
}

export interface PharmacyDashboard {
  today: { salesCount: number; totalMinor: number; prescriptionSales: number };
  month: { salesCount: number; totalMinor: number };
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
  lowStock: { medicineId: string; name: string; strength: string; reorderLevel: number; sellable: number }[];
}
