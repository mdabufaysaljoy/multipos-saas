import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';
import { SHOP_UNIT_TYPES } from './ShopProduct';

/**
 * A Super Shop sale put aside to be finished later.
 *
 * It is NOT a sale, and it is deliberately not a `ShopSale` with a third status.
 * Every report, every export, the ledger and the plan meters all filter
 * `status: 'completed'`, and a fourth state in that collection would mean
 * re-auditing every one of them. A parked basket has taken no stock, no money
 * and no points; it belongs in its own collection, where nothing can mistake it
 * for trade.
 *
 * WHAT IS STORED IS INTENT, NOT MONEY. The lines keep a product and a quantity;
 * the name, unit and price beside them are a SNAPSHOT for the list, never a
 * price to sell at. Resuming re-prices the whole basket from the catalogue, so a
 * price change while a basket sat parked is picked up rather than smuggled past
 * the till.
 *
 * Holds expire on their own: `expiresAt` carries a TTL index, so MongoDB removes
 * a basket nobody came back for without this deployment needing a sweep job.
 */
export interface ShopHeldSaleLine {
  productId: Types.ObjectId;
  /** Pieces, or grams for weighed goods - the same base unit a sale uses. */
  quantity: number;
  /** For the list only. The catalogue decides the real price on resume. */
  nameSnapshot: string;
  unitType: (typeof SHOP_UNIT_TYPES)[number];
  unitPriceMinorSnapshot: number;
}

export interface ShopHeldSaleDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  /** HOLD-000001, per branch, so a cashier can call one out loud. */
  holdNumber: string;
  /** What the cashier called it: "blue jacket", "table 3". Optional. */
  label: string;
  items: ShopHeldSaleLine[];
  /** A customer already on file. */
  customerId: Types.ObjectId | null;
  /** Or one typed at the till and not yet created. */
  customerDraft: { name: string; phone: string } | null;
  discountMinor: number;
  /**
   * The loyalty card that was scanned, by NUMBER rather than id: resuming looks
   * it up again, so the points balance shown is today's and not the one from
   * whenever the basket was parked.
   */
  loyaltyCardNumber: string;
  note: string;
  /** For the list. Recomputed from the catalogue on resume. */
  estimatedTotalMinor: number;
  heldBy: Types.ObjectId;
  heldByNameSnapshot: string;
  /** When MongoDB will remove it. Pushed forward whenever it is touched. */
  expiresAt: Date;
}

const heldLineSchema = new Schema<ShopHeldSaleLine>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'ShopProduct', required: true },
    quantity: { type: Number, required: true, min: 1 },
    nameSnapshot: { type: String, default: '' },
    unitType: { type: String, enum: [...SHOP_UNIT_TYPES], default: 'each' },
    unitPriceMinorSnapshot: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const shopHeldSaleSchema = new Schema<ShopHeldSaleDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    holdNumber: { type: String, required: true },
    label: { type: String, trim: true, maxlength: 60, default: '' },
    items: { type: [heldLineSchema], required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerDraft: {
      type: new Schema({ name: { type: String, default: '' }, phone: { type: String, default: '' } }, { _id: false }),
      default: null,
    },
    discountMinor: { type: Number, default: 0, min: 0 },
    loyaltyCardNumber: { type: String, default: '' },
    note: { type: String, trim: true, maxlength: 300, default: '' },
    estimatedTotalMinor: { type: Number, default: 0, min: 0 },
    heldBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    heldByNameSnapshot: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// The list: this branch's holds, newest first.
shopHeldSaleSchema.index({ tenantId: 1, storeId: 1, createdAt: -1 });
shopHeldSaleSchema.index({ tenantId: 1, storeId: 1, holdNumber: 1 }, { unique: true });
// Stale holds remove themselves; see `heldSales.service` for the policy.
shopHeldSaleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ShopHeldSaleModel = model<ShopHeldSaleDoc>('ShopHeldSale', shopHeldSaleSchema);
