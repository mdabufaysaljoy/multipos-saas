import { Schema, model, type Types } from 'mongoose';
import type { PaymentMethod } from '../config/constants';
import type { BaseDoc } from './types';

export const PHARMACY_SALE_STATUSES = ['completed', 'voided'] as const;
export type PharmacySaleStatus = (typeof PHARMACY_SALE_STATUSES)[number];

/** Which batch a sold quantity came from - what a recall needs to know. */
export interface BatchAllocation {
  batchId: Types.ObjectId;
  batchNumber: string;
  expiryDate: Date;
  quantity: number;
  costPriceMinor: number;
}

export interface PharmacySaleLine {
  _id: Types.ObjectId;
  medicineId: Types.ObjectId;
  nameSnapshot: string;
  genericNameSnapshot: string;
  strengthSnapshot: string;
  dosageFormSnapshot: string;
  requiresPrescription: boolean;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
  allocations: BatchAllocation[];
  /** True when this line dispensed stock the branch did not have on record. */
  outOfStockOverride?: boolean;
}

export interface PrescriptionRecord {
  patientName: string;
  prescriberName: string;
  prescriptionNumber: string;
  note: string;
}

/**
 * A completed pharmacy sale in one branch. Every figure is computed on the
 * server from the catalogue and the batches actually taken, and is never
 * recomputed. A voided sale keeps every line; its stock went back to the
 * batches it came from.
 */
export interface PharmacySaleDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  saleNumber: string;
  items: PharmacySaleLine[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  /** Cost of the batches sold, for margin. */
  costMinor: number;
  paidMinor: number;
  changeMinor: number;
  payments: { method: PaymentMethod | string; amountMinor: number; methodLabel?: string }[];
  prescription: PrescriptionRecord | null;
  customerId: Types.ObjectId | null;
  customerNameSnapshot: string;
  note: string;
  status: PharmacySaleStatus;
  soldAt: Date;
  cashierId: Types.ObjectId;
  cashierNameSnapshot: string;
  voidedAt: Date | null;
  voidedBy: Types.ObjectId | null;
  voidedByNameSnapshot: string;
  voidReason: string;
}

const minor = { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'Amounts must be whole minor units' } };

const allocationSchema = new Schema<BatchAllocation>(
  {
    batchId: { type: Schema.Types.ObjectId, ref: 'MedicineBatch', required: true },
    batchNumber: { type: String, required: true },
    expiryDate: { type: Date, required: true },
    quantity: { type: Number, required: true, min: 1 },
    costPriceMinor: minor,
  },
  { _id: false },
);

const lineSchema = new Schema<PharmacySaleLine>({
  medicineId: { type: Schema.Types.ObjectId, ref: 'Medicine', required: true },
  nameSnapshot: { type: String, required: true },
  genericNameSnapshot: { type: String, default: '' },
  strengthSnapshot: { type: String, default: '' },
  dosageFormSnapshot: { type: String, default: '' },
  requiresPrescription: { type: Boolean, default: false },
  unitPriceMinor: minor,
  quantity: { type: Number, required: true, min: 1 },
  lineTotalMinor: minor,
  allocations: { type: [allocationSchema], default: [] },
  outOfStockOverride: { type: Boolean },
});

const prescriptionSchema = new Schema<PrescriptionRecord>(
  {
    patientName: { type: String, required: true, trim: true, maxlength: 120 },
    prescriberName: { type: String, required: true, trim: true, maxlength: 120 },
    prescriptionNumber: { type: String, trim: true, maxlength: 60, default: '' },
    note: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { _id: false },
);

const pharmacySaleSchema = new Schema<PharmacySaleDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    saleNumber: { type: String, required: true },
    items: { type: [lineSchema], required: true },
    subtotalMinor: minor,
    discountMinor: minor,
    totalMinor: minor,
    costMinor: minor,
    paidMinor: minor,
    changeMinor: minor,
    payments: {
      type: [
        new Schema(
          {
            // A key, built-in or one this workspace defined; the label is kept
            // with the sale so renaming a method cannot rewrite history.
            method: { type: String, required: true, trim: true, maxlength: 24 },
            amountMinor: minor,
            methodLabel: { type: String, default: '' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    prescription: { type: prescriptionSchema, default: null },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerNameSnapshot: { type: String, default: '' },
    note: { type: String, trim: true, maxlength: 300, default: '' },
    status: { type: String, enum: [...PHARMACY_SALE_STATUSES], default: 'completed' },
    soldAt: { type: Date, required: true },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    cashierNameSnapshot: { type: String, required: true },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    voidedByNameSnapshot: { type: String, default: '' },
    voidReason: { type: String, default: '' },
  },
  { timestamps: true },
);

pharmacySaleSchema.index({ tenantId: 1, storeId: 1, saleNumber: 1 }, { unique: true });
pharmacySaleSchema.index({ tenantId: 1, storeId: 1, soldAt: -1 });
// Monthly allowance meter.
pharmacySaleSchema.index({ tenantId: 1, status: 1, soldAt: 1 });

export const PharmacySaleModel = model<PharmacySaleDoc>('PharmacySale', pharmacySaleSchema);
