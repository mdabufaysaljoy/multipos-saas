import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * One size, set or version of a dish: 8 / 10 / 12 inch, Quarter / Half / Full,
 * 1 / 2 / 3 persons.
 *
 * A variant answers "WHICH version?", so exactly one is chosen and its price
 * REPLACES the dish's own. Compare `MenuAddOnOption`, which answers "what EXTRA?",
 * where several may be chosen and each price is added. Keeping the two apart
 * in the schema is what stops a kitchen modelling "Large" as an add-on and
 * ending up with two sizes on one line.
 */
export interface MenuItemVariant {
  _id: Types.ObjectId;
  name: string;
  /** Minor units. What the line is charged at when this variant is chosen. */
  priceMinor: number;
  /** The kitchen's own code for it. Optional, and unique within the dish. */
  sku: string;
  isAvailable: boolean;
  sortOrder: number;
}

/**
 * One extra AS OFFERED ON ONE DISH: Extra cheese +80, Extra sauce +30.
 *
 * The name and price are this dish's own copy, so the same extra may cost
 * different amounts on different dishes. `addOnId` points back at the
 * workspace's reusable list (`models/MenuAddOn`) when it was picked from there,
 * which is what lets a shop define "Extra cheese" once and reuse it.
 */
export interface MenuAddOnOption {
  /** The library entry this came from, when it was picked rather than typed. */
  addOnId: Types.ObjectId | null;
  _id: Types.ObjectId;
  name: string;
  /** Minor units, ADDED to whatever the line already costs. */
  priceMinor: number;
  isAvailable: boolean;
  sortOrder: number;
}

/**
 * A set of extras offered together, with how many of them may be taken.
 *
 * `minSelect` 1 makes the group a required choice (a curry that must name its
 * heat); `maxSelect` caps how many extras one line may carry.
 */
export interface MenuAddOnGroup {
  _id: Types.ObjectId;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: MenuAddOnOption[];
  sortOrder: number;
}

/**
 * A dish or drink on a Restaurant workspace's menu.
 *
 * The menu is workspace-wide, shared by every branch, like the Clothing
 * catalogue. Orders copy the name and price at the moment a line is added, so
 * editing or removing a menu item never changes a past order.
 *
 * The hierarchy is section -> dish -> variant, with add-ons hanging off the
 * dish. `category` is a NAME, not an id: see
 * `services/catalogue/posCategories.service`. Every field below `priceMinor` is
 * optional, so a dish that is just a dish at one price - which is most of them -
 * carries none of it and behaves exactly as before.
 */
export interface MenuItemDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  name: string;
  category: string;
  description: string;
  /**
   * Minor units. The price of a dish that has NO variants; when it has them,
   * the chosen variant's price is charged instead and this is the fallback that
   * keeps every dish priced.
   */
  priceMinor: number;
  variants: MenuItemVariant[];
  addOnGroups: MenuAddOnGroup[];
  isAvailable: boolean;
  sortOrder: number;
  createdBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const price = {
  type: Number,
  required: true,
  min: 0,
  validate: { validator: Number.isSafeInteger, message: 'priceMinor must be an integer' },
};

const variantSchema = new Schema<MenuItemVariant>({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  priceMinor: price,
  sku: { type: String, trim: true, maxlength: 40, default: '' },
  isAvailable: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0, min: 0 },
});

const addOnSchema = new Schema<MenuAddOnOption>({
  addOnId: { type: Schema.Types.ObjectId, ref: 'MenuAddOn', default: null },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  priceMinor: price,
  isAvailable: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0, min: 0 },
});

const addOnGroupSchema = new Schema<MenuAddOnGroup>({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  minSelect: { type: Number, default: 0, min: 0, max: 20 },
  maxSelect: { type: Number, default: 1, min: 1, max: 20 },
  options: { type: [addOnSchema], default: [] },
  sortOrder: { type: Number, default: 0, min: 0 },
});

const menuItemSchema = new Schema<MenuItemDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: String, trim: true, maxlength: 60, default: 'General' },
    description: { type: String, trim: true, maxlength: 300, default: '' },
    priceMinor: price,
    variants: { type: [variantSchema], default: [] },
    addOnGroups: { type: [addOnGroupSchema], default: [] },
    isAvailable: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

menuItemSchema.index({ tenantId: 1, deletedAt: 1, category: 1, sortOrder: 1, name: 1 });

export const MenuItemModel = model<MenuItemDoc>('MenuItem', menuItemSchema);
