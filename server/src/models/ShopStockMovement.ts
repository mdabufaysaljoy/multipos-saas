import { Schema, model, type Types } from 'mongoose';

export const SHOP_MOVEMENT_TYPES = ['receive', 'sale', 'void', 'adjust', 'write_off'] as const;
export type ShopMovementType = (typeof SHOP_MOVEMENT_TYPES)[number];

/**
 * Append-only ledger of every stock change in a supershop branch. Quantities
 * are signed, in the product's base unit (pieces or grams). Never updated or
 * deleted, so a product's stock can always be traced.
 */
export interface ShopStockMovementDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  productId: Types.ObjectId;
  productNameSnapshot: string;
  unitType: string;
  type: ShopMovementType;
  quantity: number;
  balanceAfter: number;
  /** Receipts only: cost per piece or per kg of what was received. */
  unitCostMinor: number | null;
  reason: string;
  referenceId: Types.ObjectId | null;
  referenceNumber: string;
  createdBy: Types.ObjectId | null;
  createdByNameSnapshot: string;
  createdAt: Date;
}

const shopMovementSchema = new Schema<ShopStockMovementDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'ShopProduct', required: true },
    productNameSnapshot: { type: String, default: '' },
    unitType: { type: String, default: 'each' },
    type: { type: String, enum: [...SHOP_MOVEMENT_TYPES], required: true },
    quantity: { type: Number, required: true },
    balanceAfter: { type: Number, required: true, min: 0 },
    unitCostMinor: { type: Number, default: null },
    reason: { type: String, trim: true, maxlength: 200, default: '' },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    referenceNumber: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdByNameSnapshot: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

shopMovementSchema.index({ tenantId: 1, storeId: 1, productId: 1, createdAt: -1 });
shopMovementSchema.index({ tenantId: 1, storeId: 1, createdAt: -1 });

export const ShopStockMovementModel = model<ShopStockMovementDoc>('ShopStockMovement', shopMovementSchema);
