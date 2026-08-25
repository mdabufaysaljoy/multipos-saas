import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export interface CustomerDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  totalSpentMinor: number;
  orderCount: number;
  lastPurchaseAt: Date | null;
  isActive: boolean;
  deletedAt: Date | null;
}

const customerSchema = new Schema<CustomerDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
    email: { type: String, default: '', lowercase: true, trim: true },
    address: { type: String, default: '', maxlength: 400 },
    notes: { type: String, default: '', maxlength: 1000 },
    totalSpentMinor: { type: Number, default: 0 },
    orderCount: { type: Number, default: 0 },
    lastPurchaseAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

customerSchema.index({ tenantId: 1, storeId: 1, phone: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
customerSchema.index({ tenantId: 1, storeId: 1, name: 1 });

export const CustomerModel = model<CustomerDoc>('Customer', customerSchema);
