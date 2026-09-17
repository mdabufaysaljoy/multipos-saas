import type { Types } from 'mongoose';
import { ROLES } from '../../config/constants';
import type { Permission } from '../../config/permissions';
import { resolvePermissions } from '../../middleware/auth';
import { ApiError } from '../../utils/ApiError';
import type { TenantContext } from '../../types/express';

/**
 * The rule that stops privilege escalation through staff and role management.
 *
 * A workspace administrator may grant anything. Anyone else - however they got
 * `staff.edit` or `roles.manage` - is bound by what they hold themselves:
 *
 *   1. never grant a permission (directly, via a role, or by lifting a denial)
 *      that they do not hold;
 *   2. never manage someone, or a role, that holds more than they do;
 *   3. never change their own access (enforced by the callers);
 *   4. never hand out a branch they do not work in.
 *
 * Checked on the RESULTING effective permission set, so every route to a grant
 * (extra permissions, a role, removing a denial) is covered by the same test.
 */

export interface AccessGrant {
  roleId: Types.ObjectId | null;
  extraPermissions: string[];
  deniedPermissions: string[];
}

/** The permissions a staff grant resolves to in this workspace. */
export function effectivePermissions(ctx: TenantContext, grant: AccessGrant) {
  return resolvePermissions({
    role: ROLES.STAFF,
    roleId: grant.roleId,
    extraPermissions: grant.extraPermissions ?? [],
    deniedPermissions: grant.deniedPermissions ?? [],
    tenantId: ctx.tenantId,
  });
}

const beyondActor = (ctx: TenantContext, permissions: readonly string[]) =>
  [...new Set(permissions)].filter((permission) => !ctx.permissions.includes(permission as Permission));

/** Rule 1: the permissions being granted must all be held by the actor. */
export function assertWithinAuthority(ctx: TenantContext, permissions: readonly string[], action: string) {
  if (ctx.isAdmin) return;
  const beyond = beyondActor(ctx, permissions);
  if (beyond.length > 0) {
    throw new ApiError('FORBIDDEN', `You cannot ${action} with permissions you do not hold yourself: ${beyond.join(', ')}`, {
      permissions: beyond,
    });
  }
}

/** Rule 2: the person being managed must not hold more than the actor. */
export async function assertCanManage(ctx: TenantContext, current: AccessGrant, who = 'this staff member') {
  if (ctx.isAdmin) return;
  const beyond = beyondActor(ctx, await effectivePermissions(ctx, current));
  if (beyond.length > 0) {
    throw new ApiError('FORBIDDEN', `You cannot manage ${who}: they hold permissions you do not`, { permissions: beyond });
  }
}

/** Rule 4: branches handed out must be ones the actor works in. */
export function assertBranchesWithinAuthority(ctx: TenantContext, storeIds: (Types.ObjectId | null | undefined)[]) {
  if (ctx.isAdmin) return;
  const allowed = new Set((ctx.allowedStoreIds ?? [ctx.storeId]).map(String));
  const outside = storeIds.filter((id): id is Types.ObjectId => Boolean(id)).filter((id) => !allowed.has(String(id)));
  if (outside.length > 0) throw ApiError.forbidden('You can only assign branches you work in yourself');
}

/** True when an update touches who can do what (as opposed to name or phone). */
export const changesAccess = (input: Record<string, unknown>) =>
  ['roleId', 'extraPermissions', 'deniedPermissions', 'storeId', 'storeAccess', 'isActive'].some((key) => input[key] !== undefined);
