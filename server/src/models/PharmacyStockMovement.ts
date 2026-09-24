import { Schema, model, type Types } from 'mongoose';

export const STOCK_MOVEMENT_TYPES = ['receive', 'sale', 'void', 'adjust', 'write_off'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/**
 * Append-only ledger of every change to a medicine batch: stock received,
 * sold, returned by a void, corrected or written off. Nothing updates or
 * deletes these rows, so a batch's history can always be traced.
 */
export interface PharmacyStockMovementDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  medicineId: Types.ObjectId;
  batchId: Types.ObjectId;
  batchNumberSnapshot: string;
  medicineNameSnapshot: string;
  type: StockMovementType;
  /** Signed: positive adds stock, negative removes it. */
  quantity: number;
  balanceAfter: number;
  reason: string;
  referenceId: Types.ObjectId | null;
  referenceNumber: string;
  createdBy: Types.ObjectId | null;
  createdByNameSnapshot: string;
  /** True when this movement sold stock the branch did not have (`sales.sellOutOfStock`). */
  outOfStockOverride?: boolean;
  createdAt: Date;
}

const movementSchema = new Schema<PharmacyStockMovementDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    medicineId: { type: Schema.Types.ObjectId, ref: 'Medicine', required: true },
    batchId: { type: Schema.Types.ObjectId, ref: 'MedicineBatch', required: true },
    batchNumberSnapshot: { type: String, required: true },
    medicineNameSnapshot: { type: String, default: '' },
    type: { type: String, enum: [...STOCK_MOVEMENT_TYPES], required: true },
    quantity: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    reason: { type: String, trim: true, maxlength: 200, default: '' },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    referenceNumber: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdByNameSnapshot: { type: String, default: '' },
    outOfStockOverride: { type: Boolean },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

movementSchema.index({ tenantId: 1, storeId: 1, medicineId: 1, createdAt: -1 });
movementSchema.index({ tenantId: 1, batchId: 1, createdAt: -1 });

export const PharmacyStockMovementModel = model<PharmacyStockMovementDoc>('PharmacyStockMovement', movementSchema);
