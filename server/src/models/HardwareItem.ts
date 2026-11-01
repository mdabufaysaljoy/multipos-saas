import { Schema, model } from 'mongoose';
import type { BaseDoc } from './types';

export const HARDWARE_STATUSES = ['active', 'inactive'] as const;
export type HardwareStatus = (typeof HARDWARE_STATUSES)[number];

/**
 * What kind of device this is. Drives the icon the storefront draws and the
 * grouping on the hardware page, so adding a kind is a code change rather than
 * free text an admin can misspell into its own group.
 */
export const HARDWARE_CATEGORIES = [
  'computer',
  'scanner',
  'cash_drawer',
  'receipt_printer',
  'label_printer',
  'printer_combo',
  'accessory',
] as const;
export type HardwareCategory = (typeof HARDWARE_CATEGORIES)[number];

/**
 * One piece of POS hardware the platform resells: a scanner, a drawer, a
 * printer. Items are sold on their own AND are the parts a `HardwarePackage`
 * is built from, so a price lives in exactly one place.
 *
 * This is catalogue, not stock: nothing here is deducted, reserved or sold
 * through the POS. An order is a conversation with sales, which is why the
 * storefront's only action is "Order now".
 */
export interface HardwareItemDoc extends BaseDoc {
  slug: string;
  name: string;
  category: HardwareCategory;
  /** One line under the name, e.g. "80mm thermal receipt printer". */
  summary: string;
  /** Bullet points shown on the card. */
  specs: string[];
  /** Price in minor units (poisha). Platform currency is BDT. */
  priceMinor: number;
  imageUrl: string;
  status: HardwareStatus;
  sortOrder: number;
}

const hardwareItemSchema = new Schema<HardwareItemDoc>(
  {
    // Stable: packages refer to their parts by slug.
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      immutable: true,
      match: /^[a-z0-9][a-z0-9-]{1,47}$/,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    category: { type: String, enum: [...HARDWARE_CATEGORIES], default: 'accessory' },
    summary: { type: String, trim: true, default: '', maxlength: 160 },
    specs: { type: [String], default: [] },
    priceMinor: { type: Number, required: true, min: 0 },
    imageUrl: { type: String, trim: true, default: '', maxlength: 600 },
    status: { type: String, enum: [...HARDWARE_STATUSES], default: 'active' },
    sortOrder: { type: Number, default: 100, min: 0, max: 1000 },
  },
  { timestamps: true },
);

hardwareItemSchema.index({ slug: 1 }, { unique: true });
hardwareItemSchema.index({ status: 1, sortOrder: 1 });

export const HardwareItemModel = model<HardwareItemDoc>('HardwareItem', hardwareItemSchema);
