import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * A dish or drink on a Restaurant workspace's menu.
 *
 * The menu is workspace-wide, shared by every branch, like the Clothing
 * catalogue. Orders copy the name and price at the moment a line is added, so
 * editing or removing a menu item never changes a past order.
 */
export interface MenuItemDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  name: string;
  category: string;
  description: string;
  /** Minor units. The ONLY source of an order line's price. */
  priceMinor: number;
  isAvailable: boolean;
  sortOrder: number;
  createdBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const menuItemSchema = new Schema<MenuItemDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: String, trim: true, maxlength: 60, default: 'General' },
    description: { type: String, trim: true, maxlength: 300, default: '' },
    priceMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: 'priceMinor must be an integer' },
    },
    isAvailable: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

menuItemSchema.index({ tenantId: 1, deletedAt: 1, category: 1, sortOrder: 1, name: 1 });

export const MenuItemModel = model<MenuItemDoc>('MenuItem', menuItemSchema);
