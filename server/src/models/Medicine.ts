import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const DOSAGE_FORMS = [
  'tablet',
  'capsule',
  'syrup',
  'suspension',
  'injection',
  'cream',
  'ointment',
  'drops',
  'inhaler',
  'powder',
  'other',
] as const;
export type DosageForm = (typeof DOSAGE_FORMS)[number];

/**
 * A medicine in a Pharmacy workspace's catalogue, shared by every branch.
 *
 * Stock is NOT held here: it lives in dated batches per branch
 * (`MedicineBatch`), because a pharmacy must sell the earliest expiry first
 * and must never sell an expired strip. Sales copy the name, strength and
 * price at the moment of sale, so editing a medicine never changes history.
 */
export interface MedicineDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  /** Brand / trade name, e.g. "Napa". */
  name: string;
  /** International non-proprietary name, e.g. "Paracetamol". */
  genericName: string;
  /** e.g. "500 mg", "5 mg/5 ml". */
  strength: string;
  dosageForm: DosageForm;
  manufacturer: string;
  category: string;
  barcode: string;
  /** Minor units per unit sold. The ONLY source of a sale line's price. */
  sellingPriceMinor: number;
  /** A sale containing this medicine must record a prescription. */
  requiresPrescription: boolean;
  /** Sellable units at or below this appear as low stock (0 = no alert). */
  reorderLevel: number;
  isActive: boolean;
  createdBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const money = { validator: Number.isSafeInteger, message: 'Amounts must be whole minor units' };

const medicineSchema = new Schema<MedicineDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    genericName: { type: String, trim: true, maxlength: 120, default: '' },
    strength: { type: String, trim: true, maxlength: 40, default: '' },
    dosageForm: { type: String, enum: [...DOSAGE_FORMS], default: 'tablet' },
    manufacturer: { type: String, trim: true, maxlength: 120, default: '' },
    category: { type: String, trim: true, maxlength: 60, default: 'General' },
    barcode: { type: String, trim: true, maxlength: 64, default: '' },
    sellingPriceMinor: { type: Number, required: true, min: 0, validate: money },
    requiresPrescription: { type: Boolean, default: false },
    reorderLevel: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

medicineSchema.index({ tenantId: 1, deletedAt: 1, name: 1 });
medicineSchema.index({ tenantId: 1, deletedAt: 1, genericName: 1 });
medicineSchema.index({ tenantId: 1, barcode: 1 });

export const MedicineModel = model<MedicineDoc>('Medicine', medicineSchema);
