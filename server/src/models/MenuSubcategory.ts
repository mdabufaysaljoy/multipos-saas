import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * A subsection of one menu section: Pizza -> Italian, Mexican, Naga Hot.
 *
 * This is Restaurant's own, deliberately NOT a parent field on the shared
 * `PosCategory`. That collection is keyed (tenant, vertical, slug) and read by
 * Super Shop and Pharmacy as a flat list; giving it a hierarchy would change
 * two POS types that never asked for one, and would need a migration. Here the
 * hierarchy is exactly one level deep and belongs to the restaurant.
 *
 * It follows the same discipline as the section list above it: the NAME is the
 * link (`MenuItem.subcategory` carries it), a renamed subsection rewrites the
 * dishes that carry it, and past orders keep the name they were sold under.
 * A dish does not need a subsection - most menus have plain dishes that sit
 * directly under a section.
 */
export interface MenuSubcategoryDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  /** The section this belongs to, as a name and as its slug (the join key). */
  categoryName: string;
  categorySlug: string;
  name: string;
  slug: string;
  isActive: boolean;
  sortOrder: number;
  createdBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const menuSubcategorySchema = new Schema<MenuSubcategoryDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    categoryName: { type: String, required: true, trim: true, maxlength: 60 },
    categorySlug: { type: String, required: true, trim: true, maxlength: 80 },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slug: { type: String, required: true, trim: true, maxlength: 80 },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The list, in the order the owner put it.
menuSubcategorySchema.index({ tenantId: 1, deletedAt: 1, categorySlug: 1, sortOrder: 1, name: 1 });
// One name per section, per workspace. Two sections may both have "Hot".
menuSubcategorySchema.index(
  { tenantId: 1, categorySlug: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

export const MenuSubcategoryModel = model<MenuSubcategoryDoc>('MenuSubcategory', menuSubcategorySchema);
