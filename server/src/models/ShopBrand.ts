import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * A brand a Super Shop sells under.
 *
 * Built the same way as `PosCategory`: the product keeps the brand as a NAME,
 * so this collection is the LIST of names - what exists, what is still offered
 * and in what order - and renaming one rewrites the products that carry it.
 * Sales keep the name they were sold under, so last month's receipt is never
 * rewritten.
 *
 * Nothing had to be migrated for this to appear. A brand that products already
 * use is part of the list whether or not a row was ever written for it, which
 * is what lets a workspace that has been typing brand names for months start
 * managing them without losing any (see `shopBrands.service`).
 *
 * Super Shop only. Clothing keeps brand as free text on its own model,
 * Pharmacy calls the equivalent `manufacturer`, and a restaurant has none -
 * so unlike `PosCategory` this collection is not shared between verticals.
 * If another vertical ever needs it, this is the service to generalise.
 */
export interface ShopBrandDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  name: string;
  slug: string;
  /** Hidden from the till and from new products, without touching what uses it. */
  isActive: boolean;
  /** Lower comes first; equal values fall back to the name. */
  sortOrder: number;
  deletedAt: Date | null;
}

const shopBrandSchema = new Schema<ShopBrandDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One live row per name per workspace; a removed name can be used again.
shopBrandSchema.index({ tenantId: 1, slug: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
shopBrandSchema.index({ tenantId: 1, deletedAt: 1, sortOrder: 1, name: 1 });

export const ShopBrandModel = model<ShopBrandDoc>('ShopBrand', shopBrandSchema);
