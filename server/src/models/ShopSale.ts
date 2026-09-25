import { Schema, model, type Types } from 'mongoose';
import type { PaymentMethod } from '../config/constants';
import { SHOP_UNIT_TYPES, type ShopUnitType } from './ShopProduct';
import type { BaseDoc } from './types';
import { saleLoyaltySchema, type SaleLoyaltySnapshot } from './saleLoyalty';

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
  /** How much of this line has come back. Absent on sales taken before returns existed. */
  returnedQuantity?: number;
}

/**
 * A completed supershop sale in one branch. Every figure is computed on the
 * server and never recomputed. Prices include VAT; `vatMinor` is the VAT
 * contained in the total actually charged.
 */
/** What a sale did to a loyalty card: the shared snapshot, under this vertical's name. */
export type ShopSaleLoyalty = SaleLoyaltySnapshot;

/** The exchange this sale replaced, for the receipt and for tracing it back. */
export interface ShopSaleExchange {
  /** The return that paid for it. Filled in once that return is written. */
  returnId: Types.ObjectId | null;
  returnNumber: string;
  originalSaleId: Types.ObjectId;
  originalSaleNumber: string;
  /** Refund value of the returned goods, applied here instead of paid out. */
  creditMinor: number;
  /** What came back, snapshotted at the time of the exchange, for the receipt. */
  returnedItems: { nameSnapshot: string; detailSnapshot: string; quantity: number; unitType: string; lineTotalMinor: number }[];
}

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
  /** The loyalty card this sale earned or redeemed on. Null for most sales. */
  loyalty: ShopSaleLoyalty | null;
  status: ShopSaleStatus;
  /** Value returned against this sale so far, and whether nothing is left. */
  returnedTotalMinor?: number;
  fullyReturned?: boolean;
  /**
   * Set when this sale is the REPLACEMENT side of an exchange: the returned
   * goods' refund value paid for part of it. Absent on every ordinary sale, so
   * sales taken before exchanges existed load unchanged.
   */
  exchange?: ShopSaleExchange | null;
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
  returnedQuantity: { type: Number, default: 0, min: 0 },
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
    loyalty: { type: saleLoyaltySchema(), default: null },
    status: { type: String, enum: [...SHOP_SALE_STATUSES], default: 'completed' },
    returnedTotalMinor: { type: Number, default: 0, min: 0 },
    fullyReturned: { type: Boolean, default: false },
    exchange: {
      type: new Schema(
        {
          returnId: { type: Schema.Types.ObjectId, ref: 'Return', default: null },
          returnNumber: { type: String, default: '' },
          originalSaleId: { type: Schema.Types.ObjectId, ref: 'ShopSale', required: true },
          originalSaleNumber: { type: String, required: true },
          creditMinor: minor,
          returnedItems: {
            type: [
              new Schema(
                {
                  nameSnapshot: { type: String, required: true },
                  detailSnapshot: { type: String, default: '' },
                  quantity: { type: Number, required: true, min: 1 },
                  unitType: { type: String, default: 'each' },
                  lineTotalMinor: minor,
                },
                { _id: false },
              ),
            ],
            default: [],
          },
        },
        { _id: false },
      ),
      default: null,
    },
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
/**
 * Advanced Analytics: every one of its aggregations starts from this branch's
 * completed sales in a window. The `(tenantId, storeId, soldAt)` index above
 * cannot serve it without also scanning voided sales, and the
 * `(tenantId, status, soldAt)` one spans every branch.
 */
shopSaleSchema.index({ tenantId: 1, storeId: 1, status: 1, soldAt: -1 });

export const ShopSaleModel = model<ShopSaleDoc>('ShopSale', shopSaleSchema);
