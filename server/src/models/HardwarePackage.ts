import { Schema, model } from 'mongoose';
import { HARDWARE_STATUSES, type HardwareStatus } from './HardwareItem';
import type { BaseDoc } from './types';

export interface HardwarePackageLine {
  /** `HardwareItem.slug`. The part's name and price are never copied here. */
  itemSlug: string;
  quantity: number;
}

/**
 * A bundle of hardware sold as one counter setup.
 *
 * The parts are held as references, never as a snapshot: a package page must
 * show the same price for a scanner as the scanner's own card does, and an
 * admin who corrects a price should not have to find every bundle that
 * mentions it. `priceMinor` is the package's OWN price, which is what the
 * customer pays - it is kept separate so a bundle can be discounted below the
 * sum of its parts without touching them.
 */
export interface HardwarePackageDoc extends BaseDoc {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  items: HardwarePackageLine[];
  priceMinor: number;
  imageUrl: string;
  /** Selling points: "Fast billing", "Barcode support". */
  highlights: string[];
  /** Trades this setup suits: "Clothing shop", "Pharmacy". */
  bestFor: string[];
  /** Lifted to the top of the storefront page. */
  featured: boolean;
  status: HardwareStatus;
  sortOrder: number;
}

const hardwarePackageSchema = new Schema<HardwarePackageDoc>(
  {
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      immutable: true,
      match: /^[a-z0-9][a-z0-9-]{1,47}$/,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    tagline: { type: String, trim: true, default: '', maxlength: 120 },
    description: { type: String, trim: true, default: '', maxlength: 600 },
    items: {
      type: [
        new Schema<HardwarePackageLine>(
          {
            itemSlug: { type: String, required: true, trim: true, lowercase: true },
            quantity: { type: Number, default: 1, min: 1, max: 99 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    priceMinor: { type: Number, required: true, min: 0 },
    imageUrl: { type: String, trim: true, default: '', maxlength: 600 },
    highlights: { type: [String], default: [] },
    bestFor: { type: [String], default: [] },
    featured: { type: Boolean, default: false },
    status: { type: String, enum: [...HARDWARE_STATUSES], default: 'active' },
    sortOrder: { type: Number, default: 100, min: 0, max: 1000 },
  },
  { timestamps: true },
);

hardwarePackageSchema.index({ slug: 1 }, { unique: true });
hardwarePackageSchema.index({ status: 1, sortOrder: 1 });

export const HardwarePackageModel = model<HardwarePackageDoc>('HardwarePackage', hardwarePackageSchema);
