import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const IMPORT_STATUSES = ['pending', 'completed', 'failed', 'cancelled'] as const;
export type ProductImportStatus = (typeof IMPORT_STATUSES)[number];

/**
 * One bulk product import: the validated plan while it waits to be confirmed,
 * and the record of what it created afterwards.
 *
 * The UPLOADED FILE IS NEVER STORED. What is kept between "Validate & preview"
 * and "Confirm import" is the validated product data itself (bounded by
 * MAX_IMPORT_ROWS), which is discarded once the import runs or expires, leaving
 * only counts for the history.
 */
export interface ProductImportJobDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  filename: string;
  format: 'xlsx' | 'csv';
  status: ProductImportStatus;
  createMissingCategories: boolean;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  productsPlanned: number;
  productsCreated: number;
  variantsCreated: number;
  rowsImported: number;
  rowsFailed: number;
  categoriesCreated: number;
  /** The validated products, held only until the import is confirmed. */
  plan: Record<string, unknown>[];
  /** Row errors from validation, capped; never the file itself. (`errors` is taken by Mongoose.) */
  rowErrors: Record<string, unknown>[];
  error: string;
  expiresAt: Date | null;
  requestedBy: Types.ObjectId | null;
  requestedByNameSnapshot: string;
  completedAt: Date | null;
}

const productImportJobSchema = new Schema<ProductImportJobDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    filename: { type: String, default: '', maxlength: 260 },
    format: { type: String, enum: ['xlsx', 'csv'], required: true },
    status: { type: String, enum: IMPORT_STATUSES, required: true },
    createMissingCategories: { type: Boolean, default: false },
    totalRows: { type: Number, default: 0 },
    validRows: { type: Number, default: 0 },
    invalidRows: { type: Number, default: 0 },
    productsPlanned: { type: Number, default: 0 },
    productsCreated: { type: Number, default: 0 },
    variantsCreated: { type: Number, default: 0 },
    rowsImported: { type: Number, default: 0 },
    rowsFailed: { type: Number, default: 0 },
    categoriesCreated: { type: Number, default: 0 },
    plan: { type: [{ type: Schema.Types.Mixed }], default: [] },
    rowErrors: { type: [{ type: Schema.Types.Mixed }], default: [] },
    error: { type: String, default: '', maxlength: 300 },
    expiresAt: { type: Date, default: null },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    requestedByNameSnapshot: { type: String, default: '' },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

productImportJobSchema.index({ tenantId: 1, storeId: 1, createdAt: -1 });
// A preview that is never confirmed removes itself, so unconfirmed plans do not
// accumulate. Completed jobs have no expiry and stay as history.
productImportJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ProductImportJobModel = model<ProductImportJobDoc>('ProductImportJob', productImportJobSchema);
