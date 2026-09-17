import { Schema, model } from 'mongoose';
import type { BaseDoc } from './types';

export const POS_PRODUCT_STATUSES = ['active', 'inactive'] as const;
export type PosProductStatus = (typeof POS_PRODUCT_STATUSES)[number];

/** Icon names the client knows how to draw. Anything else is refused. */
export const POS_PRODUCT_ICONS = ['shirt', 'utensils', 'pill', 'shopping-cart', 'store', 'package'] as const;
export type PosProductIcon = (typeof POS_PRODUCT_ICONS)[number];

export interface PosProductConfiguration {
  /** Display order in lists, lowest first. */
  sortOrder: number;
  /** Short selling points shown when choosing a POS type. */
  highlights: string[];
}

/**
 * A POS product the platform offers: Clothing, Restaurant, Pharmacy, ...
 *
 * This is the platform-level DEFINITION only. A workspace records which one it
 * runs in `Tenant.vertical` (the product `code`). Whether a workspace of this
 * type can actually be opened also needs a POS module in the codebase
 * (`hasPosModule`), so activating a definition never exposes functionality that
 * does not exist. Deactivating one stops NEW workspaces; existing workspaces and
 * their history are untouched.
 */
export interface PosProductDoc extends BaseDoc {
  code: string;
  name: string;
  description: string;
  status: PosProductStatus;
  icon: PosProductIcon;
  configuration: PosProductConfiguration;
}

const posProductSchema = new Schema<PosProductDoc>(
  {
    // Stable: workspaces and plan overrides refer to it.
    code: { type: String, required: true, trim: true, lowercase: true, immutable: true, match: /^[a-z][a-z0-9_]{1,31}$/ },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, default: '', maxlength: 500 },
    status: { type: String, enum: [...POS_PRODUCT_STATUSES], default: 'inactive' },
    icon: { type: String, enum: [...POS_PRODUCT_ICONS], default: 'store' },
    configuration: {
      sortOrder: { type: Number, default: 100, min: 0, max: 1000 },
      highlights: { type: [String], default: [] },
    },
  },
  { timestamps: true },
);

posProductSchema.index({ code: 1 }, { unique: true });
posProductSchema.index({ status: 1, 'configuration.sortOrder': 1 });

export const PosProductModel = model<PosProductDoc>('PosProduct', posProductSchema);
