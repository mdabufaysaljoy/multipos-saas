import { Schema, model, type Types } from 'mongoose';
import type { PaymentMethod } from '../config/constants';
import { SHOP_UNIT_TYPES, type ShopUnitType } from './ShopProduct';
import type { BaseDoc } from './types';

export const SHOP_SALE_STATUSES = ['completed', 'voided'] as const;
export type ShopSaleStatus = (typeof SHOP_SALE_STATUSES)[number];

export interface ShopSaleLine {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  nameSnapshot: string;
  brandSnapshot: string;
  barcodeSnapshot: string;
  categorySnapshot: string;
  unitType: ShopUnitType;
  /** Per piece or per kilogram, VAT included. */
  unitPriceMinor: number;
  /** Pieces or grams. */
  quantity: number;
  lineTotalMinor: number;
  vatRateBps: number;
  /** VAT contained in `lineTotalMinor` (before any sale discount). */
  vatMinor: number;
  /** Cost of the goods sold, from the branch's average cost at the time. */
  costMinor: number;
  /** True when this line was sold with stock the branch did not have. */
  outOfStockOverride?: boolean;
}

/**
 * A completed supershop sale in one branch. Every figure is computed on the
 * server and never recomputed. Prices include VAT; `vatMinor` is the VAT
 * contained in the total actually charged.
 */
export interface ShopSaleDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  saleNumber: string;
  items: ShopSaleLine[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  vatMinor: number;
  costMinor: number;
  paidMinor: number;
  changeMinor: number;
  payments: { method: PaymentMethod | string; amountMinor: number; methodLabel?: string }[];
  customerId: Types.ObjectId | null;
  customerNameSnapshot: string;
  note: string;
  status: ShopSaleStatus;
  soldAt: Date;
  cashierId: Types.ObjectId;
  cashierNameSnapshot: string;
  voidedAt: Date | null;
  voidedBy: Types.ObjectId | null;
  voidedByNameSnapshot: string;
  voidReason: string;
}

const minor = { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'Amounts must be whole minor units' } };

const lineSchema = new Schema<ShopSaleLine>({
  productId: { type: Schema.Types.ObjectId, ref: 'ShopProduct', required: true },
  nameSnapshot: { type: String, required: true },
  brandSnapshot: { type: String, default: '' },
  barcodeSnapshot: { type: String, default: '' },
  categorySnapshot: { type: String, default: '' },
  unitType: { type: String, enum: [...SHOP_UNIT_TYPES], required: true },
  unitPriceMinor: minor,
  quantity: { type: Number, required: true, min: 1 },
  lineTotalMinor: minor,
  vatRateBps: { type: Number, default: 0, min: 0 },
  vatMinor: minor,
  costMinor: minor,
  outOfStockOverride: { type: Boolean },
});

const shopSaleSchema = new Schema<ShopSaleDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    saleNumber: { type: String, required: true },
    items: { type: [lineSchema], required: true },
    subtotalMinor: minor,
    discountMinor: minor,
    totalMinor: minor,
    vatMinor: minor,
    costMinor: minor,
    paidMinor: minor,
    changeMinor: minor,
    payments: {
      type: [
        new Schema(
          {
            // A key, built-in or one this workspace defined; the label is kept
            // with the sale so renaming a method cannot rewrite history.
            method: { type: String, required: true, trim: true, maxlength: 24 },
            amountMinor: minor,
            methodLabel: { type: String, default: '' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerNameSnapshot: { type: String, default: '' },
    note: { type: String, trim: true, maxlength: 300, default: '' },
    status: { type: String, enum: [...SHOP_SALE_STATUSES], default: 'completed' },
    soldAt: { type: Date, required: true },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    cashierNameSnapshot: { type: String, required: true },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    voidedByNameSnapshot: { type: String, default: '' },
    voidReason: { type: String, default: '' },
  },
  { timestamps: true },
);

shopSaleSchema.index({ tenantId: 1, storeId: 1, saleNumber: 1 }, { unique: true });
shopSaleSchema.index({ tenantId: 1, storeId: 1, soldAt: -1 });
shopSaleSchema.index({ tenantId: 1, status: 1, soldAt: 1 });

export const ShopSaleModel = model<ShopSaleDoc>('ShopSale', shopSaleSchema);
