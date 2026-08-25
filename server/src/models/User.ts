import bcrypt from 'bcryptjs';
import { Schema, model, type Types } from 'mongoose';
import { env } from '../config/env';
import { ROLES, type UserRole } from '../config/constants';
import type { BaseDoc } from './types';

export interface UserDoc extends BaseDoc {
  /** null for platform administrators, who are not owned by any tenant. */
  tenantId: Types.ObjectId | null;
  storeId: Types.ObjectId | null;
  name: string;
  email: string;
  phone: string;
  passwordHash: string;
  role: UserRole;
  roleId: Types.ObjectId | null;
  /** Direct grants layered on top of the assigned role. */
  extraPermissions: string[];
  /** Explicit denials that win over role grants (admins are still exempt). */
  deniedPermissions: string[];
  isActive: boolean;
  lastLoginAt: Date | null;
  /** Bumped when permissions change so issued access tokens can be revalidated. */
  permissionVersion: number;
  deletedAt: Date | null;
  comparePassword(candidate: string): Promise<boolean>;
}

const userSchema = new Schema<UserDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', default: null },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, trim: true, default: '' },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: Object.values(ROLES), required: true, index: true },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', default: null },
    extraPermissions: { type: [String], default: [] },
    deniedPermissions: { type: [String], default: [] },
    isActive: { type: Boolean, default: true, index: true },
    lastLoginAt: { type: Date, default: null },
    permissionVersion: { type: Number, default: 1 },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete (ret as Record<string, unknown>).passwordHash;
        return ret;
      },
    },
  },
);

// Email is unique per tenant so the same person can own accounts in several
// workspaces; platform admins (tenantId null) share one global namespace.
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });
userSchema.index({ tenantId: 1, isActive: 1, deletedAt: 1 });

userSchema.methods.comparePassword = function comparePassword(candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.passwordHash);
};

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, env.BCRYPT_ROUNDS);

export const UserModel = model<UserDoc>('User', userSchema);
