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
  /**
   * Permissions added to this role by a one-off default grant (see
   * `migrations/grantOutOfStockPermission.ts`), so re-running the migration never
   * re-grants a permission the tenant admin has since removed.
   */
  appliedPermissionDefaults?: string[];
}

const roleSchema = new Schema<RoleDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: '', maxlength: 300 },
    permissions: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    appliedPermissionDefaults: { type: [String], default: undefined },
  },
  { timestamps: true },
);

roleSchema.index({ tenantId: 1, name: 1 }, { unique: true });

export const RoleModel = model<RoleDoc>('Role', roleSchema);
