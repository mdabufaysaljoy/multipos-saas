import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/** Common suggestions for the manual form. Imports and manual entry may use any non-empty form. */
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
export type DosageForm = string;

/** One canonical value prevents "Tablet" and " tablet " becoming separate forms. */
export const normalizeDosageForm = (form: string): string => form.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');

/** Pharmacy categories are deliberately derived from the dosage form. */
export const categoryForDosageForm = (form: string): string =>
  normalizeDosageForm(form).replace(/(^|[\s/-])\p{L}/gu, (letter) => letter.toLocaleUpperCase('en-US'));

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
  /** Bottle, strip, blister, tube, vial, etc. */
  containerType: string;
  /** Human-readable manufacturer packaging, e.g. "10 x 10 tablets". */
  packageSize: string;
  category: string;
  barcode: string;
  /** Minor units per unit sold. The ONLY source of a sale line's price. */
  sellingPriceMinor: number;
  /** Sellable units in one manufacturer pack. Stock remains unit-based. */
  packQuantity: number;
  /** Exact pack total: sellingPriceMinor × packQuantity. */
  packPriceMinor: number;
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
    dosageForm: { type: String, required: true, trim: true, maxlength: 60, default: 'tablet' },
    manufacturer: { type: String, trim: true, maxlength: 120, default: '' },
    containerType: { type: String, trim: true, maxlength: 60, default: '' },
    packageSize: { type: String, trim: true, maxlength: 80, default: '' },
    category: { type: String, trim: true, maxlength: 60, default: 'Tablet' },
    barcode: { type: String, trim: true, maxlength: 64, default: '' },
    sellingPriceMinor: { type: Number, required: true, min: 0, validate: money },
    packQuantity: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
      validate: { validator: Number.isSafeInteger, message: 'Pack quantity must be a whole number' },
    },
    packPriceMinor: { type: Number, required: true, min: 0, default: 0, validate: money },
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
