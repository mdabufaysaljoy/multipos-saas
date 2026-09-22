import { Schema, model, type Types } from 'mongoose';
import { INVENTORY_TX_TYPES } from '../config/constants';
import type { BaseDoc } from './types';

/**
 * Append-only inventory ledger. Current stock lives on the variant for speed,
 * but every change is recorded here so stock can be audited and reconstructed.
 */
export interface InventoryTransactionDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId;
  productNameSnapshot: string;
  variantNameSnapshot: string;
  skuSnapshot: string;
  type: string;
  /** Negative for outbound, positive for inbound. Always an integer. */
  quantityChange: number;
  previousStock: number;
  newStock: number;
  reason: string;
  referenceType: 'sale' | 'return' | 'adjustment' | 'product' | null;
  referenceId: Types.ObjectId | null;
  referenceNumber: string;
  performedBy: Types.ObjectId | null;
  performedByNameSnapshot: string;
  /** True when a sale took this variant from zero or below (permission `sales.sellOutOfStock`). */
  outOfStockOverride?: boolean;
}

const inventoryTxSchema = new Schema<InventoryTransactionDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true, index: true },
    productNameSnapshot: { type: String, default: '' },
    variantNameSnapshot: { type: String, default: '' },
    skuSnapshot: { type: String, default: '' },
    type: { type: String, enum: Object.values(INVENTORY_TX_TYPES), required: true },
    quantityChange: { type: Number, required: true, validate: { validator: Number.isSafeInteger, message: 'quantityChange must be a whole number' } },
    previousStock: { type: Number, required: true },
    newStock: { type: Number, required: true },
    reason: { type: String, default: '', maxlength: 300 },
    referenceType: { type: String, enum: ['sale', 'return', 'adjustment', 'product', null], default: null },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    referenceNumber: { type: String, default: '' },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    performedByNameSnapshot: { type: String, default: '' },
    outOfStockOverride: { type: Boolean },
  },
  { timestamps: true },
);

inventoryTxSchema.index({ tenantId: 1, storeId: 1, createdAt: -1 });
inventoryTxSchema.index({ tenantId: 1, variantId: 1, createdAt: -1 });
inventoryTxSchema.index({ tenantId: 1, referenceId: 1 });

export const InventoryTransactionModel = model<InventoryTransactionDoc>('InventoryTransaction', inventoryTxSchema);
