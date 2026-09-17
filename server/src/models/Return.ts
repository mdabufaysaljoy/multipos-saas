import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export interface ReturnItemDoc {
  _id: Types.ObjectId;
  /** Points at the specific line of the original sale. */
  saleItemId: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId;
  productNameSnapshot: string;
  variantNameSnapshot: string;
  skuSnapshot: string;
  categoryId: Types.ObjectId | null;
  categoryNameSnapshot: string;
  quantity: number;
  /** Always the price from the original sale, never the current price. */
  unitPriceMinor: number;
  /**
   * Cost carried over from the sale line, so refunding an item removes both its
   * revenue AND its cost from profit. Without this the COGS of a returned item
   * would stay on the books forever.
   */
  costPriceMinorSnapshot: number;
  lineTotalMinor: number;
  /** Whether the goods went back into sellable stock. */
  restock: boolean;
}

export interface ReturnDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  returnNumber: string;
  saleId: Types.ObjectId;
  saleNumberSnapshot: string;
  customerId: Types.ObjectId | null;
  customerSnapshot: { name: string; phone: string } | null;
  items: ReturnItemDoc[];
  totalMinor: number;
  reason: string;
  refundMethod: string;
  processedBy: Types.ObjectId;
  processedByNameSnapshot: string;
  returnedAt: Date;
}

const returnItemSchema = new Schema<ReturnItemDoc>(
  {
    saleItemId: { type: Schema.Types.ObjectId, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true },
    productNameSnapshot: { type: String, required: true },
    variantNameSnapshot: { type: String, default: '' },
    skuSnapshot: { type: String, default: '' },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    categoryNameSnapshot: { type: String, default: 'Uncategorised' },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Return quantity must be positive'],
      validate: { validator: Number.isSafeInteger, message: 'quantity must be a whole number' },
    },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    // Defaults to 0 so returns created before this field existed still load.
    costPriceMinorSnapshot: { type: Number, default: 0, min: 0 },
    lineTotalMinor: { type: Number, required: true, min: 0 },
    restock: { type: Boolean, default: true },
  },
  { _id: true },
);

const returnSchema = new Schema<ReturnDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    returnNumber: { type: String, required: true },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true, index: true },
    saleNumberSnapshot: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerSnapshot: {
      type: new Schema({ name: { type: String, default: '' }, phone: { type: String, default: '' } }, { _id: false }),
      default: null,
    },
    items: { type: [returnItemSchema], required: true },
    totalMinor: { type: Number, required: true, min: 0 },
    reason: { type: String, default: '', maxlength: 500 },
    refundMethod: { type: String, default: 'cash' },
    processedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    processedByNameSnapshot: { type: String, default: '' },
    returnedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

returnSchema.index({ tenantId: 1, storeId: 1, returnNumber: 1 }, { unique: true });
returnSchema.index({ tenantId: 1, storeId: 1, returnedAt: -1 });

export const ReturnModel = model<ReturnDoc>('Return', returnSchema);
