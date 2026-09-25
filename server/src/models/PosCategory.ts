import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * A department a workspace sells under, for the POS types whose catalogue keeps
 * its category as a NAME on the item (Super Shop, Pharmacy, Restaurant).
 *
 * Clothing is different and stays different: its `Category` is a store-scoped
 * entity that products point at by id, with parents and snapshots. Here the
 * item keeps the name, so this collection is the LIST of names - what exists,
 * what is still offered, and in what order - and renaming one rewrites the
 * items that carry it.
 *
 * Nothing had to be migrated for this to appear: a name that items already use
 * is part of the catalogue whether or not a row was ever written for it (see
 * `posCategories.service`).
 */
export interface PosCategoryDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  /** Which POS type's catalogue this belongs to; the three share one collection. */
  vertical: string;
  name: string;
  slug: string;
  /** Hidden from the till and from new items, without touching what already uses it. */
  isActive: boolean;
  /** Lower comes first; equal values fall back to the name. */
  sortOrder: number;
  deletedAt: Date | null;
}

const posCategorySchema = new Schema<PosCategoryDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    vertical: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One live row per name per vertical; a removed name can be used again.
posCategorySchema.index({ tenantId: 1, vertical: 1, slug: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
posCategorySchema.index({ tenantId: 1, vertical: 1, deletedAt: 1, sortOrder: 1, name: 1 });

export const PosCategoryModel = model<PosCategoryDoc>('PosCategory', posCategorySchema);
