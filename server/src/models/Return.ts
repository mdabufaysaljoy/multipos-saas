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
  /** What the workspace called that method when the refund was made. */
  refundMethodLabel?: string;
  processedBy: Types.ObjectId;
  processedByNameSnapshot: string;
  returnedAt: Date;
  /** Set when refundMethod is "exchange": the value went into a replacement sale instead of being paid out. */
  exchange: ReturnExchange | null;
  /** Guards an exchange against being submitted twice. Null for ordinary returns. */
  idempotencyKey: string | null;
  /** Loyalty effect of this return. Null when the sale had no loyalty card. */
  loyalty: ReturnLoyalty | null;
}

export interface ReturnLoyalty {
  membershipId: Types.ObjectId;
  /** Points the returned goods had earned, taken back. */
  pointsEarnedReversed: number;
  /** Points the customer spent on the returned goods, given back instead of money. */
  pointsRedeemedRestored: number;
  /** pointsRedeemedRestored x the sale's point value: deducted from the money refund. */
  valueMinor: number;
}

export interface ReturnExchange {
  saleId: Types.ObjectId;
  saleNumber: string;
  /** Refund value of the returned items (original sale prices). */
  refundableMinor: number;
  /** Replacement items at their catalogue prices, before VAT. */
  replacementSubtotalMinor: number;
  /** Replacement sale total (including VAT when the store charges it on top). */
  replacementTotalMinor: number;
  /** What the customer paid on top of the refund value. */
  extraPayableMinor: number;
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
    refundMethodLabel: { type: String, default: '' },
    processedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    processedByNameSnapshot: { type: String, default: '' },
    returnedAt: { type: Date, default: Date.now, index: true },
    exchange: {
      type: new Schema<ReturnExchange>(
        {
          saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true },
          saleNumber: { type: String, default: '' },
          refundableMinor: { type: Number, required: true, min: 0 },
          replacementSubtotalMinor: { type: Number, required: true, min: 0 },
          replacementTotalMinor: { type: Number, required: true, min: 0 },
          extraPayableMinor: { type: Number, required: true, min: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
    idempotencyKey: { type: String, default: null, maxlength: 100 },
    loyalty: {
      type: new Schema<ReturnLoyalty>(
        {
          membershipId: { type: Schema.Types.ObjectId, ref: 'LoyaltyMembership', required: true },
          pointsEarnedReversed: { type: Number, default: 0, min: 0 },
          pointsRedeemedRestored: { type: Number, default: 0, min: 0 },
          valueMinor: { type: Number, default: 0, min: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);

// An exchange key is used once per branch; ordinary returns carry none.
returnSchema.index(
  { tenantId: 1, storeId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

returnSchema.index({ tenantId: 1, storeId: 1, returnNumber: 1 }, { unique: true });
returnSchema.index({ tenantId: 1, storeId: 1, returnedAt: -1 });

export const ReturnModel = model<ReturnDoc>('Return', returnSchema);
