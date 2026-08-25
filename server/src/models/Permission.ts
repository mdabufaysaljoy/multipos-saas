import { Schema, model } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * Mirror of the in-code permission catalogue. The code remains the source of
 * truth; this collection exists so the admin UI and future reporting can join
 * against stable permission records.
 */
export interface PermissionDoc extends BaseDoc {
  key: string;
  group: string;
  label: string;
  description: string;
}

const permissionSchema = new Schema<PermissionDoc>(
  {
    key: { type: String, required: true },
    group: { type: String, required: true, index: true },
    label: { type: String, required: true },
    description: { type: String, default: '' },
  },
  { timestamps: true },
);

permissionSchema.index({ key: 1 }, { unique: true });

export const PermissionModel = model<PermissionDoc>('Permission', permissionSchema);
