import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export interface CategoryDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  name: string;
  slug: string;
  description: string;
  parentId: Types.ObjectId | null;
  isActive: boolean;
  /** Soft delete: historical sales keep their category name snapshot regardless. */
  deletedAt: Date | null;
}

const categorySchema = new Schema<CategoryDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, default: '', maxlength: 500 },
    parentId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Uniqueness only applies to live categories, so a deleted name can be reused.
categorySchema.index(
  { tenantId: 1, storeId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
categorySchema.index({ tenantId: 1, storeId: 1, deletedAt: 1, isActive: 1 });

export const CategoryModel = model<CategoryDoc>('Category', categorySchema);
