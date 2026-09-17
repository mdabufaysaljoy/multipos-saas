import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * A product's stock in one branch. `quantityOnHand` (pieces or grams) only
 * changes through one atomic update guarded by the quantity available, so two
 * tills can never sell the same item. `costPriceMinor` is the weighted average
 * cost per piece or per kilogram, updated as stock is received.
 */
export interface ShopStockDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  productId: Types.ObjectId;
  quantityOnHand: number;
  costPriceMinor: number;
  lastReceivedAt: Date | null;
}

const shopStockSchema = new Schema<ShopStockDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'ShopProduct', required: true },
    quantityOnHand: { type: Number, required: true, min: 0, default: 0 },
    costPriceMinor: { type: Number, required: true, min: 0, default: 0 },
    lastReceivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

shopStockSchema.index({ tenantId: 1, storeId: 1, productId: 1 }, { unique: true });
shopStockSchema.index({ tenantId: 1, storeId: 1, quantityOnHand: 1 });

export const ShopStockModel = model<ShopStockDoc>('ShopStock', shopStockSchema);
