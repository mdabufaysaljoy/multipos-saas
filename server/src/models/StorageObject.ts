import { Schema, Types, model } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * One row per file a workspace has uploaded.
 *
 * This ownership registry makes file deletion tenant-safe. Before it existed,
 * bytes were written to storage without a durable record of which workspace
 * owned each provider key.
 *
 * Rows are soft-deleted so removed files retain an audit trail.
 */
export interface StorageObjectDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId | null;
  /** Driver-specific handle, used to delete the underlying bytes. */
  key: string;
  url: string;
  bytes: number;
  mimeType: string;
  /** Logical bucket: "products", "branding", ... */
  folder: string;
  uploadedBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const storageObjectSchema = new Schema<StorageObjectDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', default: null },
    key: { type: String, required: true },
    url: { type: String, required: true },
    bytes: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: 'bytes must be an integer' },
    },
    mimeType: { type: String, required: true },
    folder: { type: String, default: '' },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// File lifecycle and ownership queries start with the tenant's live rows.
storageObjectSchema.index({ tenantId: 1, deletedAt: 1 });
// Deleting the bytes behind a file starts from its key.
storageObjectSchema.index({ tenantId: 1, key: 1 });

export const StorageObjectModel = model<StorageObjectDoc>('StorageObject', storageObjectSchema);
