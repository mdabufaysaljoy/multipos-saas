import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export interface RoleDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  name: string;
  description: string;
  permissions: string[];
  /** System roles ship with the tenant and cannot be deleted. */
  isSystem: boolean;
  isActive: boolean;
}

const roleSchema = new Schema<RoleDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: '', maxlength: 300 },
    permissions: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

roleSchema.index({ tenantId: 1, name: 1 }, { unique: true });

export const RoleModel = model<RoleDoc>('Role', roleSchema);
