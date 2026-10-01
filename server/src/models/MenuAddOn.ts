import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * A reusable extra, defined once for the whole workspace: Extra cheese, Extra
 * sauce, Extra drink.
 *
 * A kitchen should not have to retype "Extra cheese" and its price on every
 * pizza. This is the list they pick from; attaching one to a dish copies its
 * name and price into that dish's own `addOnGroups[].options[]`, which is what
 * lets the same extra cost 80 on a pizza and 50 on a burger, and what keeps a
 * past order exact when the list is edited later.
 *
 * Like the section list, a name typed straight onto a dish
 * joins this list automatically, so nobody has to visit a management screen
 * first and nothing had to be migrated.
 */
export interface MenuAddOnDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  name: string;
  slug: string;
  /** What it usually costs. A dish may charge something else. */
  defaultPriceMinor: number;
  isActive: boolean;
  sortOrder: number;
  createdBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const menuAddOnSchema = new Schema<MenuAddOnDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slug: { type: String, required: true, trim: true, maxlength: 80 },
    defaultPriceMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: 'defaultPriceMinor must be an integer' },
    },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The list, in the order the owner put it.
menuAddOnSchema.index({ tenantId: 1, deletedAt: 1, sortOrder: 1, name: 1 });
// One of each name per workspace.
menuAddOnSchema.index({ tenantId: 1, slug: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });

export const MenuAddOnModel = model<MenuAddOnDoc>('MenuAddOn', menuAddOnSchema);
