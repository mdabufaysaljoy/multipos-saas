import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export interface PharmacyHeldSaleDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  holdNumber: string;
  items: { medicineId: Types.ObjectId; quantity: number; nameSnapshot: string; strengthSnapshot: string; unitPriceMinorSnapshot: number }[];
  customerId: Types.ObjectId | null;
  customerDraft: { name: string; phone: string } | null;
  discountMinor: number;
  prescription: { patientName: string; prescriberName: string; prescriptionNumber: string; note: string } | null;
  loyaltyCardNumber: string;
  note: string;
  estimatedTotalMinor: number;
  heldBy: Types.ObjectId;
  heldByNameSnapshot: string;
  expiresAt: Date;
}

const pharmacyHeldSaleSchema = new Schema<PharmacyHeldSaleDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    holdNumber: { type: String, required: true },
    items: {
      type: [new Schema({
        medicineId: { type: Schema.Types.ObjectId, ref: 'Medicine', required: true },
        quantity: { type: Number, required: true, min: 1 },
        nameSnapshot: { type: String, default: '' },
        strengthSnapshot: { type: String, default: '' },
        unitPriceMinorSnapshot: { type: Number, default: 0, min: 0 },
      }, { _id: false })],
      required: true,
    },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerDraft: { type: new Schema({ name: { type: String, default: '' }, phone: { type: String, default: '' } }, { _id: false }), default: null },
    discountMinor: { type: Number, default: 0, min: 0 },
    prescription: {
      type: new Schema({
        patientName: { type: String, default: '' }, prescriberName: { type: String, default: '' },
        prescriptionNumber: { type: String, default: '' }, note: { type: String, default: '' },
      }, { _id: false }),
      default: null,
    },
    loyaltyCardNumber: { type: String, default: '' },
    note: { type: String, trim: true, maxlength: 300, default: '' },
    estimatedTotalMinor: { type: Number, default: 0, min: 0 },
    heldBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    heldByNameSnapshot: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

pharmacyHeldSaleSchema.index({ tenantId: 1, storeId: 1, createdAt: -1 });
pharmacyHeldSaleSchema.index({ tenantId: 1, storeId: 1, holdNumber: 1 }, { unique: true });
pharmacyHeldSaleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PharmacyHeldSaleModel = model<PharmacyHeldSaleDoc>('PharmacyHeldSale', pharmacyHeldSaleSchema);
