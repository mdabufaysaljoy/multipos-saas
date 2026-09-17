import { Schema, Types, model } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * One row per file a workspace has uploaded.
 *
 * This is the ledger behind the storage quota. Before it existed, bytes were
 * written to disk and immediately forgotten - there was no way to answer "how
 * much is this tenant using?". Summing the ledger is the source of truth rather
 * than trusting a counter that can drift.
 *
 * Rows are soft-deleted so a removed file leaves an audit trail while freeing
 * the quota it held.
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

// The quota query: sum bytes for one tenant's live files.
storageObjectSchema.index({ tenantId: 1, deletedAt: 1 });
// Deleting the bytes behind a file starts from its key.
storageObjectSchema.index({ tenantId: 1, key: 1 });

export const StorageObjectModel = model<StorageObjectDoc>('StorageObject', storageObjectSchema);
