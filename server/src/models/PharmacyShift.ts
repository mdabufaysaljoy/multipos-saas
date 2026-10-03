import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const PHARMACY_SHIFT_STATUSES = ['open', 'closed'] as const;
export type PharmacyShiftStatus = (typeof PHARMACY_SHIFT_STATUSES)[number];
export const PHARMACY_CASH_MOVEMENT_TYPES = ['pay_in', 'pay_out'] as const;
export type PharmacyCashMovementType = (typeof PHARMACY_CASH_MOVEMENT_TYPES)[number];

export interface PharmacyCashMovement {
  _id: Types.ObjectId;
  type: PharmacyCashMovementType;
  amountMinor: number;
  reason: string;
  at: Date;
  by: Types.ObjectId | null;
  byNameSnapshot: string;
}

/** One immutable cash-drawer period in a Pharmacy branch. */
export interface PharmacyShiftDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  shiftNumber: string;
  status: PharmacyShiftStatus;
  openingFloatMinor: number;
  openingNote: string;
  openedAt: Date;
  openedBy: Types.ObjectId | null;
  openedByNameSnapshot: string;
  cashMovements: PharmacyCashMovement[];
  closedAt: Date | null;
  closedBy: Types.ObjectId | null;
  closedByNameSnapshot: string;
  closingNote: string;
  countedCashMinor: number | null;
  expectedCashMinor: number | null;
  varianceMinor: number | null;
  /** Live while open; frozen here once closed. */
  report: Record<string, unknown> | null;
}

const wholeMinor = { validator: Number.isSafeInteger, message: 'Amounts must be whole minor units' };

const cashMovementSchema = new Schema<PharmacyCashMovement>(
  {
    type: { type: String, enum: [...PHARMACY_CASH_MOVEMENT_TYPES], required: true },
    amountMinor: { type: Number, required: true, min: 1, validate: wholeMinor },
    reason: { type: String, required: true, maxlength: 200 },
    at: { type: Date, default: () => new Date() },
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    byNameSnapshot: { type: String, default: '' },
  },
  { _id: true },
);

const pharmacyShiftSchema = new Schema<PharmacyShiftDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    shiftNumber: { type: String, required: true },
    status: { type: String, enum: [...PHARMACY_SHIFT_STATUSES], default: 'open' },
    openingFloatMinor: { type: Number, default: 0, min: 0, validate: wholeMinor },
    openingNote: { type: String, default: '', maxlength: 300 },
    openedAt: { type: Date, default: () => new Date() },
    openedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    openedByNameSnapshot: { type: String, default: '' },
    cashMovements: { type: [cashMovementSchema], default: [] },
    closedAt: { type: Date, default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    closedByNameSnapshot: { type: String, default: '' },
    closingNote: { type: String, default: '', maxlength: 300 },
    countedCashMinor: { type: Number, default: null, min: 0 },
    expectedCashMinor: { type: Number, default: null },
    varianceMinor: { type: Number, default: null },
    report: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

pharmacyShiftSchema.index({ tenantId: 1, storeId: 1, openedAt: -1 });
pharmacyShiftSchema.index({ tenantId: 1, storeId: 1, shiftNumber: 1 }, { unique: true });
pharmacyShiftSchema.index(
  { tenantId: 1, storeId: 1 },
  { unique: true, partialFilterExpression: { status: 'open' }, name: 'one_open_pharmacy_shift_per_store' },
);

export const PharmacyShiftModel = model<PharmacyShiftDoc>('PharmacyShift', pharmacyShiftSchema);
