import { Schema, model, type Types } from 'mongoose';
import { PAYMENT_METHODS } from '../config/constants';
import type { BaseDoc } from './types';

export interface ReceiptSettings {
  headerText: string;
  footerText: string;
  returnPolicy: string;
  showLogo: boolean;
  showCashier: boolean;
  paperWidthMm: 58 | 78 | 80;
}

export interface TaxSettings {
  enabled: boolean;
  label: string;
  /** Basis points: 750 = 7.5%. Integer maths only. */
  rateBasisPoints: number;
  /** When true, listed prices already include tax. */
  inclusive: boolean;
}

export interface StoreDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  name: string;
  code: string;
  logoUrl: string | null;
  phone: string;
  email: string;
  address: string;
  currency: string;
  invoicePrefix: string;
  returnPrefix: string;
  receipt: ReceiptSettings;
  tax: TaxSettings;
  paymentMethods: string[];
  lowStockThreshold: number;
  isActive: boolean;
  isDefault: boolean;
}

const storeSchema = new Schema<StoreDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 16 },
    logoUrl: { type: String, default: null },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    address: { type: String, trim: true, default: '' },
    currency: { type: String, default: 'BDT', uppercase: true, minlength: 3, maxlength: 3 },
    invoicePrefix: { type: String, default: 'INV-', trim: true, maxlength: 12 },
    returnPrefix: { type: String, default: 'RET-', trim: true, maxlength: 12 },
    receipt: {
      headerText: { type: String, default: '' },
      footerText: { type: String, default: 'Thank you for shopping with us!' },
      returnPolicy: { type: String, default: 'Exchange within 7 days with receipt.' },
      showLogo: { type: Boolean, default: true },
      showCashier: { type: Boolean, default: true },
      paperWidthMm: { type: Number, enum: [58, 78, 80], default: 58 },
    },
    tax: {
      enabled: { type: Boolean, default: false },
      label: { type: String, default: 'VAT' },
      rateBasisPoints: { type: Number, default: 0, min: 0, max: 10_000 },
      inclusive: { type: Boolean, default: false },
    },
    paymentMethods: { type: [String], default: [...PAYMENT_METHODS] },
    lowStockThreshold: { type: Number, default: 5, min: 0 },
    isActive: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);

storeSchema.index({ tenantId: 1, code: 1 }, { unique: true });

export const StoreModel = model<StoreDoc>('Store', storeSchema);
