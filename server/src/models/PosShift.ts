import { Schema, model, type Types } from 'mongoose';
import type { PosVertical } from '../config/verticals';
import type { BaseDoc } from './types';

export const POS_SHIFT_VERTICALS = ['clothing', 'supershop'] as const;
export type RetailShiftVertical = Extract<PosVertical, (typeof POS_SHIFT_VERTICALS)[number]>;
export type PosShiftStatus = 'open' | 'closed';
export type PosCashMovementType = 'pay_in' | 'pay_out';

export interface PosCashMovement {
  _id: Types.ObjectId;
  type: PosCashMovementType;
  amountMinor: number;
  reason: string;
  at: Date;
  by: Types.ObjectId | null;
  byNameSnapshot: string;
}

/**
 * Shared cash-drawer shift for retail-style POS verticals. Restaurant and
 * Pharmacy retain their existing collections so no historical report moves or
 * changes shape. New retail verticals can join this engine by adding an
 * adapter, rather than growing another copy of the shift lifecycle.
 */
export interface PosShiftDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  vertical: RetailShiftVertical;
  shiftNumber: string;
  status: PosShiftStatus;
  openingFloatMinor: number;
  openingNote: string;
  openedAt: Date;
  openedBy: Types.ObjectId | null;
  openedByNameSnapshot: string;
  cashMovements: PosCashMovement[];
  closedAt: Date | null;
  closedBy: Types.ObjectId | null;
  closedByNameSnapshot: string;
  closingNote: string;
  countedCashMinor: number | null;
  expectedCashMinor: number | null;
  varianceMinor: number | null;
  report: Record<string, unknown> | null;
}

const wholeMinor = { validator: Number.isSafeInteger, message: 'Amounts must be whole minor units' };
const movementSchema = new Schema<PosCashMovement>({
  type: { type: String, enum: ['pay_in', 'pay_out'], required: true },
  amountMinor: { type: Number, required: true, min: 1, validate: wholeMinor },
  reason: { type: String, required: true, maxlength: 200 },
  at: { type: Date, default: () => new Date() },
  by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  byNameSnapshot: { type: String, default: '' },
});

const posShiftSchema = new Schema<PosShiftDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    vertical: { type: String, enum: [...POS_SHIFT_VERTICALS], required: true },
    shiftNumber: { type: String, required: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    openingFloatMinor: { type: Number, default: 0, min: 0, validate: wholeMinor },
    openingNote: { type: String, default: '', maxlength: 300 },
    openedAt: { type: Date, default: () => new Date() },
    openedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    openedByNameSnapshot: { type: String, default: '' },
    cashMovements: { type: [movementSchema], default: [] },
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

posShiftSchema.index({ tenantId: 1, storeId: 1, vertical: 1, openedAt: -1 });
posShiftSchema.index({ tenantId: 1, storeId: 1, vertical: 1, shiftNumber: 1 }, { unique: true });
posShiftSchema.index(
  { tenantId: 1, storeId: 1, vertical: 1 },
  { unique: true, partialFilterExpression: { status: 'open' }, name: 'one_open_retail_shift_per_store' },
);

export const PosShiftModel = model<PosShiftDoc>('PosShift', posShiftSchema);
