import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const SHIFT_STATUSES = ['open', 'closed'] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

export const CASH_MOVEMENT_TYPES = ['pay_in', 'pay_out'] as const;
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

/** Cash put into or taken out of the drawer for something other than a sale. */
export interface CashMovement {
  _id: Types.ObjectId;
  type: CashMovementType;
  amountMinor: number;
  reason: string;
  at: Date;
  by: Types.ObjectId | null;
  byNameSnapshot: string;
}

/**
 * A cash-drawer shift in one Restaurant branch.
 *
 * Opened with a float, closed with a physical cash count. Orders paid while it
 * is open carry its id. On close the Z-report is computed once and frozen on
 * the document, so the end-of-shift figures never change afterwards - and a
 * closed shift is never reopened or edited.
 */
export interface RestaurantShiftDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  shiftNumber: string;
  status: ShiftStatus;
  openingFloatMinor: number;
  openingNote: string;
  openedAt: Date;
  openedBy: Types.ObjectId | null;
  openedByNameSnapshot: string;
  cashMovements: CashMovement[];
  closedAt: Date | null;
  closedBy: Types.ObjectId | null;
  closedByNameSnapshot: string;
  closingNote: string;
  countedCashMinor: number | null;
  expectedCashMinor: number | null;
  /** counted - expected: negative is a shortage, positive an overage. */
  varianceMinor: number | null;
  /** The frozen Z-report. Null while the shift is open. */
  report: Record<string, unknown> | null;
}

const wholeMinor = { validator: Number.isSafeInteger, message: 'Amounts must be whole minor units' };

const cashMovementSchema = new Schema<CashMovement>({
  type: { type: String, enum: [...CASH_MOVEMENT_TYPES], required: true },
  amountMinor: { type: Number, required: true, min: 1, validate: wholeMinor },
  reason: { type: String, required: true, maxlength: 200 },
  at: { type: Date, default: () => new Date() },
  by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  byNameSnapshot: { type: String, default: '' },
});

const restaurantShiftSchema = new Schema<RestaurantShiftDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    shiftNumber: { type: String, required: true },
    status: { type: String, enum: [...SHIFT_STATUSES], default: 'open' },
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

restaurantShiftSchema.index({ tenantId: 1, storeId: 1, openedAt: -1 });
restaurantShiftSchema.index({ tenantId: 1, storeId: 1, status: 1, closedAt: -1 });
restaurantShiftSchema.index({ tenantId: 1, storeId: 1, shiftNumber: 1 }, { unique: true });
// At most one OPEN shift per branch, enforced by the database.
restaurantShiftSchema.index(
  { tenantId: 1, storeId: 1 },
  { unique: true, partialFilterExpression: { status: 'open' }, name: 'one_open_shift_per_store' },
);

export const RestaurantShiftModel = model<RestaurantShiftDoc>('RestaurantShift', restaurantShiftSchema);
