import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/** A table in one branch of a Restaurant workspace. */
export interface DiningTableDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  name: string;
  seats: number;
  isActive: boolean;
  deletedAt: Date | null;
}

const diningTableSchema = new Schema<DiningTableDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    seats: { type: Number, default: 4, min: 1, max: 50 },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

diningTableSchema.index({ tenantId: 1, storeId: 1, deletedAt: 1, name: 1 });

export const DiningTableModel = model<DiningTableDoc>('DiningTable', diningTableSchema);
