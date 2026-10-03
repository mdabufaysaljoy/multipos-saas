import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/** A manufacturer name managed by one Pharmacy workspace. */
export interface PharmacyManufacturerDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  name: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  deletedAt: Date | null;
}

const pharmacyManufacturerSchema = new Schema<PharmacyManufacturerDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

pharmacyManufacturerSchema.index(
  { tenantId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
pharmacyManufacturerSchema.index({ tenantId: 1, deletedAt: 1, sortOrder: 1, name: 1 });

export const PharmacyManufacturerModel = model<PharmacyManufacturerDoc>('PharmacyManufacturer', pharmacyManufacturerSchema);
