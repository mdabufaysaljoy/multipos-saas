import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export interface ProductOption {
  /** e.g. "Color", "Size" */
  name: string;
  values: string[];
}

export interface ProductImage {
  url: string;
  key: string | null;
  isPrimary: boolean;
}

export interface ProductDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  name: string;
  /** Base/parent SKU. Sellable SKUs live on the variants. */
  sku: string;
  categoryId: Types.ObjectId | null;
  categoryNameSnapshot: string;
  description: string;
  brand: string;
  images: ProductImage[];
  options: ProductOption[];
  /** false when the product is sold as a single default variant. */
  hasVariants: boolean;
  isActive: boolean;
  deletedAt: Date | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

const productSchema = new Schema<ProductDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    sku: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    categoryNameSnapshot: { type: String, default: '' },
    description: { type: String, default: '', maxlength: 2000 },
    brand: { type: String, default: '', trim: true, maxlength: 120 },
    images: {
      type: [
        new Schema<ProductImage>(
          {
            url: { type: String, required: true },
            key: { type: String, default: null },
            isPrimary: { type: Boolean, default: false },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    options: {
      type: [
        new Schema<ProductOption>(
          {
            name: { type: String, required: true, trim: true },
            values: { type: [String], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    hasVariants: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

productSchema.index({ tenantId: 1, storeId: 1, sku: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
productSchema.index({ tenantId: 1, storeId: 1, deletedAt: 1, isActive: 1 });
productSchema.index({ tenantId: 1, storeId: 1, categoryId: 1 });
// The POS product grid: active products of a branch, in name order, paged.
productSchema.index({ tenantId: 1, storeId: 1, deletedAt: 1, isActive: 1, name: 1 });
productSchema.index({ tenantId: 1, name: 'text', brand: 'text', sku: 'text' });

export const ProductModel = model<ProductDoc>('Product', productSchema);
