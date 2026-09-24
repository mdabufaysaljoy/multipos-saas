import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * One manufacturer batch of a medicine held in one branch.
 *
 * `quantityOnHand` only ever changes through a single atomic `$inc` guarded by
 * the quantity available, so two tills can never sell the same strip. A batch
 * is sellable while `expiryDate` (a UTC calendar date) is today or later.
 */
export interface MedicineBatchDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  medicineId: Types.ObjectId;
  batchNumber: string;
  expiryDate: Date;
  quantityReceived: number;
  quantityOnHand: number;
  /** Purchase cost per unit, in minor units, for margin and write-off value. */
  costPriceMinor: number;
  supplierName: string;
  receivedAt: Date;
  receivedBy: Types.ObjectId | null;
  receivedByNameSnapshot: string;
}

const medicineBatchSchema = new Schema<MedicineBatchDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    medicineId: { type: Schema.Types.ObjectId, ref: 'Medicine', required: true },
    batchNumber: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },
    expiryDate: { type: Date, required: true },
    quantityReceived: { type: Number, required: true, min: 0 },
    // No floor: a till with `sales.sellOutOfStock` may dispense from a batch
    // the system thinks is empty, which takes it below zero. Never for an
    // expired batch, and never without a batch to attribute the units to.
    quantityOnHand: { type: Number, required: true },
    costPriceMinor: { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'Cost must be whole minor units' } },
    supplierName: { type: String, trim: true, maxlength: 120, default: '' },
    receivedAt: { type: Date, default: () => new Date() },
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    receivedByNameSnapshot: { type: String, default: '' },
  },
  { timestamps: true },
);

// One record per batch of a medicine in a branch.
medicineBatchSchema.index({ tenantId: 1, storeId: 1, medicineId: 1, batchNumber: 1 }, { unique: true });
// First-expiry-first-out allocation.
medicineBatchSchema.index({ tenantId: 1, storeId: 1, medicineId: 1, expiryDate: 1 });
// Expiry reports.
medicineBatchSchema.index({ tenantId: 1, storeId: 1, expiryDate: 1, quantityOnHand: 1 });

export const MedicineBatchModel = model<MedicineBatchDoc>('MedicineBatch', medicineBatchSchema);
