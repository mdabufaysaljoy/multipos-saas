import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * How a supershop product is sold and counted.
 *   each    quantity = number of pieces; price per piece
 *   weight  quantity = GRAMS (integer); price per kilogram
 * Quantities are always integers, so weighed goods never touch floating point.
 */
export const SHOP_UNIT_TYPES = ['each', 'weight'] as const;
export type ShopUnitType = (typeof SHOP_UNIT_TYPES)[number];

/**
 * A product in a Supershop workspace's catalogue, shared by every branch.
 * Stock is held per branch in `ShopStock`. Sales snapshot the name, barcode,
 * price and VAT rate, so editing a product never changes a past sale.
 */
export interface ShopProductDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  name: string;
  brand: string;
  /** Department / aisle, e.g. "Grocery", "Personal care". */
  category: string;
  barcode: string;
  unitType: ShopUnitType;
  /** Minor units per piece (`each`) or per kilogram (`weight`). VAT included. */
  priceMinor: number;
  /** VAT rate in basis points (1500 = 15%), already included in the price. */
  vatRateBps: number;
  /** In base units (pieces or grams). At or below this the product is low on stock. */
  reorderLevel: number;
  isActive: boolean;
  createdBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const shopProductSchema = new Schema<ShopProductDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    brand: { type: String, trim: true, maxlength: 80, default: '' },
    category: { type: String, trim: true, maxlength: 60, default: 'General' },
    barcode: { type: String, trim: true, maxlength: 64, default: '' },
    unitType: { type: String, enum: [...SHOP_UNIT_TYPES], default: 'each' },
    priceMinor: { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'Price must be whole minor units' } },
    vatRateBps: { type: Number, default: 0, min: 0, max: 10_000 },
    reorderLevel: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

shopProductSchema.index({ tenantId: 1, deletedAt: 1, category: 1, name: 1 });
// The scanner path: one exact barcode lookup per beep.
shopProductSchema.index({ tenantId: 1, barcode: 1 });

export const ShopProductModel = model<ShopProductDoc>('ShopProduct', shopProductSchema);
