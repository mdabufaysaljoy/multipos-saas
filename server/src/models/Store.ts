import { Schema, model, type Types } from 'mongoose';
import { PAYMENT_METHODS } from '../config/constants';
import type { BaseDoc } from './types';

export interface ReceiptSettings {
  headerText: string;
  footerText: string;
  returnPolicy: string;
  showLogo: boolean;
  showCashier: boolean;
  paperWidthMm: 48 | 58 | 78 | 80;
}

export interface TaxSettings {
  enabled: boolean;
  label: string;
  /** Basis points: 750 = 7.5%. Integer maths only. */
  rateBasisPoints: number;
  /** When true, listed prices already include tax. */
  inclusive: boolean;
}

/**
 * Loyalty program rules (Clothing POS, plans with the loyalty entitlement).
 * All money in minor units, so no floating point anywhere:
 *   earnSpendMinor 10000  = every ৳100 of qualifying spend earns 1 point
 *   pointValueMinor 100   = 1 point is worth ৳1.00 of discount (50 = ৳0.50)
 *   membershipFeeMinor 0  = cards are issued free until the owner sets a fee
 */
export interface LoyaltySettings {
  enabled: boolean;
  earnSpendMinor: number;
  pointValueMinor: number;
  membershipFeeMinor: number;
}

export const RECEIPT_WIDTHS_MM = [48, 58, 78, 80] as const;
export const PRODUCT_LABEL_WIDTHS_MM = [38, 48, 58] as const;
export const LOYALTY_CARD_WIDTHS_MM = [48, 58, 85] as const;
export const LABEL_PAPERS = ['sheet', 'roll'] as const;

/**
 * Barcode label printing. `sheet` lays labels out on a normal page (A4 sticker
 * sheets); `roll` sets the printed page to the label width, one label per row,
 * for label printers.
 */
export interface LabelSettings {
  productWidthMm: (typeof PRODUCT_LABEL_WIDTHS_MM)[number];
  loyaltyCardWidthMm: (typeof LOYALTY_CARD_WIDTHS_MM)[number];
  paper: (typeof LABEL_PAPERS)[number];
}

export const DEFAULT_LABEL_SETTINGS: LabelSettings = { productWidthMm: 38, loyaltyCardWidthMm: 85, paper: 'sheet' };

export interface StoreDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  name: string;
  code: string;
  /** Store/application logo, shown in the POS UI. */
  logoUrl: string | null;
  /** Receipt logo, printed on thermal receipts. Deliberately separate. */
  receiptLogoUrl: string | null;
  phone: string;
  email: string;
  address: string;
  currency: string;
  invoicePrefix: string;
  returnPrefix: string;
  receipt: ReceiptSettings;
  tax: TaxSettings;
  loyalty: LoyaltySettings;
  labels: LabelSettings;
  paymentMethods: string[];
  lowStockThreshold: number;
  isActive: boolean;
  isDefault: boolean;
  /**
   * Soft delete. Sales, returns and inventory rows reference this store, so the
   * record is retained and simply hidden - deleting it outright would orphan
   * historical business data.
   */
  deletedAt: Date | null;
}

const storeSchema = new Schema<StoreDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 16 },
    logoUrl: { type: String, default: null },
    receiptLogoUrl: { type: String, default: null },
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
      paperWidthMm: { type: Number, enum: [...RECEIPT_WIDTHS_MM], default: 58 },
    },
    tax: {
      enabled: { type: Boolean, default: false },
      label: { type: String, default: 'VAT' },
      rateBasisPoints: { type: Number, default: 0, min: 0, max: 10_000 },
      inclusive: { type: Boolean, default: false },
    },
    loyalty: {
      enabled: { type: Boolean, default: false },
      earnSpendMinor: { type: Number, default: 10_000, min: 1 },
      pointValueMinor: { type: Number, default: 100, min: 1 },
      membershipFeeMinor: { type: Number, default: 0, min: 0 },
    },
    labels: {
      productWidthMm: { type: Number, enum: [...PRODUCT_LABEL_WIDTHS_MM], default: 38 },
      loyaltyCardWidthMm: { type: Number, enum: [...LOYALTY_CARD_WIDTHS_MM], default: 85 },
      paper: { type: String, enum: [...LABEL_PAPERS], default: 'sheet' },
    },
    paymentMethods: { type: [String], default: [...PAYMENT_METHODS] },
    lowStockThreshold: { type: Number, default: 5, min: 0 },
    isActive: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

storeSchema.index(
  { tenantId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
storeSchema.index({ tenantId: 1, deletedAt: 1, isActive: 1 });

export const StoreModel = model<StoreDoc>('Store', storeSchema);
