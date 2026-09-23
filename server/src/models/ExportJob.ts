import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const EXPORT_STATUSES = ['completed', 'failed'] as const;

/**
 * The record of a data export: who exported what, when, and how big it was.
 *
 * Metadata ONLY - exported rows are streamed straight to the browser and never
 * stored, so there is no file at rest and nothing sensitive in this collection.
 */
export interface ExportJobDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  type: string;
  format: string;
  /** Human-readable scope, e.g. "Last 30 days - this branch". */
  filterSummary: string;
  rangeFrom: Date | null;
  rangeTo: Date | null;
  allBranches: boolean;
  status: (typeof EXPORT_STATUSES)[number];
  rowCount: number;
  byteSize: number;
  error: string;
  requestedBy: Types.ObjectId | null;
  requestedByNameSnapshot: string;
  completedAt: Date | null;
}

const exportJobSchema = new Schema<ExportJobDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    type: { type: String, required: true },
    format: { type: String, required: true },
    filterSummary: { type: String, default: '', maxlength: 300 },
    rangeFrom: { type: Date, default: null },
    rangeTo: { type: Date, default: null },
    allBranches: { type: Boolean, default: false },
    status: { type: String, enum: EXPORT_STATUSES, required: true },
    rowCount: { type: Number, default: 0 },
    byteSize: { type: Number, default: 0 },
    error: { type: String, default: '', maxlength: 300 },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    requestedByNameSnapshot: { type: String, default: '' },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

exportJobSchema.index({ tenantId: 1, storeId: 1, createdAt: -1 });

export const ExportJobModel = model<ExportJobDoc>('ExportJob', exportJobSchema);
