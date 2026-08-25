import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export interface VariantAttribute {
  name: string;
  value: string;
}

/**
 * The sellable unit. Every product has at least one variant (a "Default" one for
 * products without options), which keeps POS, inventory, sales and returns on a
 * single uniform code path.
 */
export interface ProductVariantDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  productId: Types.ObjectId;
  /** Denormalised for fast POS search and for building snapshots. */
  productNameSnapshot: string;
  /** e.g. "Black / M" */
  name: string;
  attributes: VariantAttribute[];
  sku: string;
  barcode: string | null;
  sellingPriceMinor: number;
  costPriceMinor: number;
  /** Whole units only - enforced by validators and by `Number.isInteger` guards. */
  stock: number;
  lowStockThreshold: number;
  isActive: boolean;
  deletedAt: Date | null;
}

const variantSchema = new Schema<ProductVariantDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    productNameSnapshot: { type: String, default: '' },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    attributes: {
      type: [
        new Schema<VariantAttribute>(
          { name: { type: String, required: true }, value: { type: String, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
    sku: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },
    barcode: { type: String, default: null, trim: true },
    sellingPriceMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: 'sellingPriceMinor must be an integer (minor units)' },
    },
    costPriceMinor: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: 'costPriceMinor must be an integer (minor units)' },
    },
    stock: {
      type: Number,
      default: 0,
      min: [0, 'Stock can never be negative'],
      validate: { validator: Number.isSafeInteger, message: 'stock must be a whole number' },
    },
    lowStockThreshold: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

variantSchema.index({ tenantId: 1, storeId: 1, sku: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
// Barcodes must be unique per store among live variants. The partial filter
// keeps the index off the many variants that legitimately have no barcode, and
// lets a soft-deleted variant's code be reused.
variantSchema.index(
  { tenantId: 1, storeId: 1, barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $type: 'string' }, deletedAt: null } },
);
variantSchema.index({ tenantId: 1, productId: 1, deletedAt: 1 });
variantSchema.index({ tenantId: 1, storeId: 1, isActive: 1, deletedAt: 1 });

export const ProductVariantModel = model<ProductVariantDoc>('ProductVariant', variantSchema);
