import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const MEMBER_STATUSES = ['active', 'inactive', 'removed'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/**
 * A staff user's access to a workspace OTHER than their home one.
 *
 * The home workspace keeps reading role, branches and grants from the user
 * record, exactly as before. A membership adds one more workspace, with its own
 * role, grants and branches - it never changes what the person may do at home.
 *
 * Only a workspace of the SAME account can be joined, and only its account
 * owner can add someone. Access is re-checked on every request, so deactivating
 * or removing a membership takes effect immediately.
 */
export interface WorkspaceMemberDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  /** A role of THIS workspace. */
  roleId: Types.ObjectId | null;
  extraPermissions: string[];
  deniedPermissions: string[];
  /** Default branch in this workspace, and any others they may use. */
  storeId: Types.ObjectId | null;
  storeAccess: Types.ObjectId[];
  status: MemberStatus;
  addedBy: Types.ObjectId | null;
  addedByNameSnapshot: string;
  removedAt: Date | null;
}

const memberSchema = new Schema<WorkspaceMemberDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', default: null },
    extraPermissions: { type: [String], default: [] },
    deniedPermissions: { type: [String], default: [] },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', default: null },
    storeAccess: { type: [{ type: Schema.Types.ObjectId, ref: 'Store' }], default: [] },
    status: { type: String, enum: [...MEMBER_STATUSES], default: 'active' },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    addedByNameSnapshot: { type: String, default: '' },
    removedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One membership per person per workspace; a removed one is reactivated, not duplicated.
memberSchema.index({ tenantId: 1, userId: 1 }, { unique: true });
// "Which workspaces may this person act in?" - every request for a member.
memberSchema.index({ userId: 1, status: 1 });
// Staff seats and the members list.
memberSchema.index({ tenantId: 1, status: 1 });

export const WorkspaceMemberModel = model<WorkspaceMemberDoc>('WorkspaceMember', memberSchema);
