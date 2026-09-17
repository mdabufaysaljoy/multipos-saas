import type { Types } from 'mongoose';
import { ROLES, type UserRole } from '../../config/constants';
import { WorkspaceMemberModel } from '../../models/WorkspaceMember';
import { DEFAULT_POS_VERTICAL, type PosVertical } from '../../config/verticals';
import { AccountModel } from '../../models/Account';
import { TenantModel, type TenantDoc } from '../../models/Tenant';

/**
 * Which workspaces a signed-in user may act in. The ONE place that decides it.
 *
 *   - Every tenant user acts in their own (home) workspace, as before.
 *   - The OWNER of a platform account may also act in every other workspace of
 *     that account, as its administrator.
 *   - Staff are never granted a workspace other than their own.
 *
 * Ownership is read from the database on every call - a workspace id in a token
 * or request is only ever a REQUEST to act there, never proof of access - so
 * moving a workspace to another account takes effect on the next request.
 */
export interface WorkspaceUser {
  _id: Types.ObjectId;
  role: string;
  tenantId: Types.ObjectId | null;
}

export interface WorkspaceSummary {
  id: Types.ObjectId;
  name: string;
  vertical: PosVertical;
  status: string;
  /** The workspace the user record belongs to. */
  isHome: boolean;
}

export type WorkspaceAccessDenial = 'not_found' | 'not_owner' | 'account_suspended';

export type WorkspaceAccess =
  | { allowed: true; workspace: TenantDoc & { _id: Types.ObjectId } }
  | { allowed: false; reason: WorkspaceAccessDenial };

/**
 * THE ownership check: does this account own this workspace, and may it act?
 *
 * `accountId` must come from the authenticated identity (`accountForUser`),
 * never from the request. Callers decide how to present a denial; the HTTP
 * layer answers `not_found` and `not_owner` identically (404) so a workspace id
 * belonging to someone else cannot be told apart from one that does not exist.
 */
export async function canAccessWorkspace(accountId: Types.ObjectId, workspaceId: Types.ObjectId): Promise<WorkspaceAccess> {
  const [workspace, account] = await Promise.all([
    TenantModel.findById(workspaceId).lean<TenantDoc & { _id: Types.ObjectId }>(),
    AccountModel.findById(accountId).select('status').lean(),
  ]);
  if (!workspace) return { allowed: false, reason: 'not_found' };
  if (!account || !workspace.accountId || !workspace.accountId.equals(accountId)) return { allowed: false, reason: 'not_owner' };
  if (account.status !== 'active') return { allowed: false, reason: 'account_suspended' };
  return { allowed: true, workspace };
}

/** A user record with the fields that decide access in their HOME workspace. */
export interface ActorSourceUser extends WorkspaceUser {
  roleId: Types.ObjectId | null;
  extraPermissions: string[];
  deniedPermissions: string[];
  storeId: Types.ObjectId | null;
  storeAccess?: Types.ObjectId[];
}

/**
 * Who a user IS inside one workspace: the role, grants and branches that apply
 * there. The single answer used by `authenticate`, sessions and workspace lists.
 *
 *   home    - the user record, unchanged from before memberships existed
 *   owner   - an account owner acting in another workspace of their account (admin)
 *   member  - staff with an active membership in a workspace of the same account
 */
export interface WorkspaceActor {
  tenantId: Types.ObjectId;
  via: 'home' | 'owner' | 'member';
  role: UserRole;
  isAdmin: boolean;
  roleId: Types.ObjectId | null;
  extraPermissions: string[];
  deniedPermissions: string[];
  storeId: Types.ObjectId | null;
  storeAccess: Types.ObjectId[];
  memberId: Types.ObjectId | null;
}

export function homeActor(user: ActorSourceUser): WorkspaceActor {
  return {
    tenantId: user.tenantId!,
    via: 'home',
    role: user.role as UserRole,
    isAdmin: user.role === ROLES.ADMIN,
    roleId: user.roleId,
    extraPermissions: user.extraPermissions ?? [],
    deniedPermissions: user.deniedPermissions ?? [],
    storeId: user.storeId,
    storeAccess: user.storeAccess ?? [],
    memberId: null,
  };
}

/** The input `resolvePermissions` needs, for the workspace the actor is in. */
export const permissionSourceOf = (actor: WorkspaceActor) => ({
  role: actor.role,
  roleId: actor.roleId,
  extraPermissions: actor.extraPermissions,
  deniedPermissions: actor.deniedPermissions,
  tenantId: actor.tenantId,
});

/**
 * An active membership that is still valid: the target workspace and the
 * member's home workspace belong to the same, active account. A workspace moved
 * to another account silently stops honouring memberships from the old one.
 */
async function validMembership(user: WorkspaceUser, tenantId: Types.ObjectId) {
  const [member, target, home] = await Promise.all([
    WorkspaceMemberModel.findOne({ tenantId, userId: user._id, status: 'active' }).lean(),
    TenantModel.findById(tenantId).select('accountId').lean(),
    TenantModel.findById(user.tenantId).select('accountId').lean(),
  ]);
  if (!member || !target?.accountId || !home?.accountId || !target.accountId.equals(home.accountId)) return null;
  const account = await AccountModel.findById(target.accountId).select('status').lean();
  return account?.status === 'active' ? member : null;
}

/** Null when the user may not act in the workspace at all. */
export async function resolveActor(user: ActorSourceUser, tenantId: Types.ObjectId): Promise<WorkspaceActor | null> {
  if (!user.tenantId) return null;
  if (tenantId.equals(user.tenantId)) return homeActor(user);

  if (user.role === ROLES.ADMIN) {
    const account = await AccountModel.findOne({ ownerUserId: user._id }).select('_id').lean();
    if (!account || !(await canAccessWorkspace(account._id, tenantId)).allowed) return null;
    return {
      tenantId,
      via: 'owner',
      role: ROLES.ADMIN,
      isAdmin: true,
      roleId: null,
      extraPermissions: [],
      deniedPermissions: [],
      storeId: null,
      storeAccess: [],
      memberId: null,
    };
  }

  if (user.role !== ROLES.STAFF) return null;
  const member = await validMembership(user, tenantId);
  if (!member) return null;
  return {
    tenantId,
    via: 'member',
    // A membership never makes anyone an administrator.
    role: ROLES.STAFF,
    isAdmin: false,
    roleId: member.roleId,
    extraPermissions: member.extraPermissions ?? [],
    deniedPermissions: member.deniedPermissions ?? [],
    storeId: member.storeId,
    storeAccess: member.storeAccess ?? [],
    memberId: member._id,
  };
}

export async function canActIn(user: WorkspaceUser, tenantId: Types.ObjectId): Promise<boolean> {
  if (!user.tenantId) return false;
  if (tenantId.equals(user.tenantId)) return true;
  const actor = await resolveActor({ roleId: null, extraPermissions: [], deniedPermissions: [], storeId: null, ...user }, tenantId);
  return Boolean(actor);
}

/**
 * The workspace a session should continue in: the requested one while the user
 * may still act there and it is not suspended, otherwise their home workspace.
 * Used when rotating tokens, so a revoked or suspended workspace quietly hands
 * the session back home instead of locking the user out.
 */
export async function activeWorkspaceFor(
  user: WorkspaceUser,
  requested: Types.ObjectId | null | undefined,
): Promise<Types.ObjectId | null> {
  if (!requested || !user.tenantId || requested.equals(user.tenantId)) return user.tenantId;
  if (!(await canActIn(user, requested))) return user.tenantId;
  const tenant = await TenantModel.findById(requested).select('status').lean();
  return tenant && tenant.status !== 'suspended' ? requested : user.tenantId;
}

export async function listWorkspaces(user: WorkspaceUser): Promise<WorkspaceSummary[]> {
  if (!user.tenantId) return [];

  const fields = '_id name vertical status createdAt accountId';
  const home = await TenantModel.findById(user.tenantId).select(fields).lean();
  let tenants = home ? [home] : [];

  if (user.role === ROLES.ADMIN) {
    const account = await AccountModel.findOne({ ownerUserId: user._id }).select('_id').lean();
    if (account) {
      const owned = await TenantModel.find({ accountId: account._id }).select(fields).sort({ createdAt: 1 }).lean();
      // The home workspace is always listed, even before it is linked.
      tenants = home && !owned.some((t) => t._id.equals(home._id)) ? [home, ...owned] : owned;
    }
  }

  // Staff also see the workspaces they are an active member of (same account only).
  if (user.role === ROLES.STAFF && home?.accountId) {
    const joinedIds = await WorkspaceMemberModel.find({ userId: user._id, status: 'active' }).distinct('tenantId');
    if (joinedIds.length > 0) {
      const joined = await TenantModel.find({ _id: { $in: joinedIds }, accountId: home.accountId })
        .select(fields)
        .sort({ createdAt: 1 })
        .lean();
      tenants = [...tenants, ...joined.filter((t) => !tenants.some((existing) => existing._id.equals(t._id)))];
    }
  }

  return tenants.map((tenant) => ({
    id: tenant._id,
    name: tenant.name,
    vertical: tenant.vertical ?? DEFAULT_POS_VERTICAL,
    status: tenant.status,
    isHome: Boolean(home && tenant._id.equals(home._id)),
  }));
}
