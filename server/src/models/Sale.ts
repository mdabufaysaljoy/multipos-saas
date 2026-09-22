import { Schema, model, type Types } from 'mongoose';
import { PAYMENT_METHODS, SALE_PAYMENT_STATUS, SALE_STATUS } from '../config/constants';
import type { BaseDoc } from './types';

/**
 * A line on a completed sale. Every field needed to render the sale is
 * SNAPSHOTTED here. Nothing about this document is ever recomputed from the
 * live Product / Variant / Category, so editing or deleting a product can never
 * alter history.
 */
export interface SaleItemDoc {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId;
  productNameSnapshot: string;
  variantNameSnapshot: string;
  skuSnapshot: string;
  brandSnapshot: string;
  categoryId: Types.ObjectId | null;
  categoryNameSnapshot: string;
  /** The price actually charged, in minor units. Immutable. */
  unitPriceMinor: number;
  /** The catalogue price at the time of sale, for margin/override reporting. */
  listPriceMinor: number;
  costPriceMinorSnapshot: number;
  quantity: number;
  lineDiscountMinor: number;
  lineTotalMinor: number;
  /** Incremented atomically as returns are processed against this line. */
  returnedQuantity: number;
  /**
   * True when this line was sold with the variant at zero stock or below, by a
   * user holding `sales.sellOutOfStock` (the sale's cashier). Absent on older sales.
   */
  outOfStockOverride?: boolean;
}

export interface SalePaymentEntry {
  method: string;
  amountMinor: number;
  reference: string;
}

export interface SaleDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  saleNumber: string;
  cashierId: Types.ObjectId;
  cashierNameSnapshot: string;
  customerId: Types.ObjectId | null;
  customerSnapshot: { name: string; phone: string; email: string } | null;
  items: SaleItemDoc[];
  subtotalMinor: number;
  discountMinor: number;
  discountType: 'none' | 'fixed' | 'percent';
  discountValue: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  changeMinor: number;
  paymentMethod: string;
  payments: SalePaymentEntry[];
  paymentStatus: string;
  status: string;
  note: string;
  /** Running total of refunded value, kept in sync with Return documents. */
  returnedTotalMinor: number;
  fullyReturned: boolean;
  cancelledAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  soldAt: Date;
  /**
   * Set when this sale is the REPLACEMENT side of an exchange: the returned
   * items' refund value paid for part of it. Null for every ordinary sale.
   */
  exchange: SaleExchange | null;
  /**
   * Loyalty on this sale (Clothing POS). Null for every sale without a card.
   * `discountMinor` on the sale INCLUDES `loyalty.discountMinor`, so reports that
   * already subtract discounts stay correct.
   */
  loyalty: SaleLoyalty | null;
  /** Client-supplied request key: a retried checkout returns the first sale instead of creating another. */
  idempotencyKey: string | null;
}

export interface SaleLoyalty {
  membershipId: Types.ObjectId;
  cardNumber: string;
  /** The store's rules at the moment of sale; later setting changes never rewrite them. */
  pointValueMinor: number;
  earnSpendMinor: number;
  pointsRedeemed: number;
  /** pointsRedeemed x pointValueMinor. */
  discountMinor: number;
  /** subtotal - cart discount - loyalty discount (never VAT added on top). */
  qualifyingMinor: number;
  pointsEarned: number;
  /** Card balance right after this sale, for the receipt. */
  balanceAfter: number;
  /** Running totals given back by returns and cancellation. */
  pointsEarnedReversed: number;
  pointsRedeemedRestored: number;
}

export interface SaleExchange {
  returnId: Types.ObjectId | null;
  returnNumber: string;
  /** Refund value of the returned items, applied to this sale instead of paid out. */
  creditMinor: number;
  /** What came back, for the exchange receipt. Snapshot at the time of the exchange. */
  returnedItems: { productNameSnapshot: string; variantNameSnapshot: string; quantity: number; lineTotalMinor: number }[];
}

const saleItemSchema = new Schema<SaleItemDoc>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true },
    productNameSnapshot: { type: String, required: true },
    variantNameSnapshot: { type: String, default: '' },
    skuSnapshot: { type: String, default: '' },
    brandSnapshot: { type: String, default: '' },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    categoryNameSnapshot: { type: String, default: 'Uncategorised' },
    unitPriceMinor: {
      type: Number,
      required: true,
      min: [1, 'A completed sale line must have a positive price'],
      validate: { validator: Number.isSafeInteger, message: 'unitPriceMinor must be an integer' },
    },
    listPriceMinor: { type: Number, required: true, min: 0 },
    costPriceMinorSnapshot: { type: Number, default: 0, min: 0 },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'A completed sale line must have a positive quantity'],
      validate: { validator: Number.isSafeInteger, message: 'quantity must be a whole number' },
    },
    lineDiscountMinor: { type: Number, default: 0, min: 0 },
    lineTotalMinor: { type: Number, required: true, min: 0 },
    returnedQuantity: { type: Number, default: 0, min: 0 },
    outOfStockOverride: { type: Boolean },
  },
  { _id: true },
);

const saleSchema = new Schema<SaleDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    saleNumber: { type: String, required: true },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    cashierNameSnapshot: { type: String, default: '' },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerSnapshot: {
      type: new Schema(
        {
          name: { type: String, default: '' },
          phone: { type: String, default: '' },
          email: { type: String, default: '' },
        },
        { _id: false },
      ),
      default: null,
    },
    items: { type: [saleItemSchema], required: true },
    subtotalMinor: { type: Number, required: true, min: 0 },
    discountMinor: { type: Number, default: 0, min: 0 },
    discountType: { type: String, enum: ['none', 'fixed', 'percent'], default: 'none' },
    discountValue: { type: Number, default: 0, min: 0 },
    taxMinor: { type: Number, default: 0, min: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
    paidMinor: { type: Number, default: 0, min: 0 },
    changeMinor: { type: Number, default: 0, min: 0 },
    paymentMethod: { type: String, enum: [...PAYMENT_METHODS], required: true },
    payments: {
      type: [
        new Schema<SalePaymentEntry>(
          {
            method: { type: String, required: true },
            amountMinor: { type: Number, required: true, min: 0 },
            reference: { type: String, default: '' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    paymentStatus: { type: String, enum: [...SALE_PAYMENT_STATUS], default: 'paid' },
    status: { type: String, enum: Object.values(SALE_STATUS), default: SALE_STATUS.COMPLETED, index: true },
    note: { type: String, default: '', maxlength: 500 },
    returnedTotalMinor: { type: Number, default: 0, min: 0 },
    fullyReturned: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    soldAt: { type: Date, default: Date.now, index: true },
    exchange: {
      type: new Schema<SaleExchange>(
        {
          returnId: { type: Schema.Types.ObjectId, ref: 'Return', default: null },
          returnNumber: { type: String, default: '' },
          creditMinor: { type: Number, required: true, min: 0 },
          returnedItems: {
            type: [
              new Schema(
                {
                  productNameSnapshot: { type: String, default: '' },
                  variantNameSnapshot: { type: String, default: '' },
                  quantity: { type: Number, default: 0, min: 0 },
                  lineTotalMinor: { type: Number, default: 0, min: 0 },
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
    loyalty: {
      type: new Schema<SaleLoyalty>(
        {
          membershipId: { type: Schema.Types.ObjectId, ref: 'LoyaltyMembership', required: true },
          cardNumber: { type: String, default: '' },
          pointValueMinor: { type: Number, required: true, min: 1 },
          earnSpendMinor: { type: Number, required: true, min: 1 },
          pointsRedeemed: { type: Number, default: 0, min: 0 },
          discountMinor: { type: Number, default: 0, min: 0 },
          qualifyingMinor: { type: Number, default: 0, min: 0 },
          pointsEarned: { type: Number, default: 0, min: 0 },
          balanceAfter: { type: Number, default: 0 },
          pointsEarnedReversed: { type: Number, default: 0, min: 0 },
          pointsRedeemedRestored: { type: Number, default: 0, min: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
    idempotencyKey: { type: String, default: null, maxlength: 100 },
  },
  { timestamps: true },
);

saleSchema.index({ tenantId: 1, storeId: 1, saleNumber: 1 }, { unique: true });
// A checkout key is used once per branch; older sales carry none.
saleSchema.index({ tenantId: 1, storeId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
saleSchema.index({ tenantId: 1, 'loyalty.membershipId': 1 }, { partialFilterExpression: { 'loyalty.membershipId': { $exists: true } } });
// Primary reporting index: tenant + store + time range, with status filtering.
saleSchema.index({ tenantId: 1, storeId: 1, soldAt: -1, status: 1 });
saleSchema.index({ tenantId: 1, storeId: 1, cashierId: 1, soldAt: -1 });
saleSchema.index({ tenantId: 1, storeId: 1, customerId: 1, soldAt: -1 });
saleSchema.index({ tenantId: 1, 'customerSnapshot.phone': 1 });
// Tenant-wide monthly transaction counting for the plan limit. The reporting
// indexes above all lead with storeId, so none of them can serve a count
// across every branch.
saleSchema.index({ tenantId: 1, soldAt: -1, status: 1 });

export const SaleModel = model<SaleDoc>('Sale', saleSchema);
