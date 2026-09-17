import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { ROLES } from '../config/constants';
import { ALL_PERMISSIONS, type Permission } from '../config/permissions';
import { RoleModel } from '../models/Role';
import { UserModel } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { verifyAccessToken } from '../utils/tokens';
import { homeActor, permissionSourceOf, resolveActor, type WorkspaceActor } from '../services/account/workspaceAccess.service';
import type { AuthUser } from '../types/express';

const extractToken = (req: Request): string | null => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.accessToken;
  return cookieToken ?? null;
};

/**
 * Resolves the effective permission set for a user.
 *
 * Role information is ALWAYS read from the database - the token only carries an
 * id. A client can therefore never escalate itself by editing a payload.
 */
export async function resolvePermissions(user: {
  role: string;
  roleId: Types.ObjectId | null;
  extraPermissions: string[];
  deniedPermissions: string[];
  tenantId: Types.ObjectId | null;
}): Promise<Permission[]> {
  // Tenant admins hold every tenant-level permission by definition.
  if (user.role === ROLES.ADMIN || user.role === ROLES.PLATFORM_ADMIN) {
    return [...ALL_PERMISSIONS];
  }

  const granted = new Set<string>();

  if (user.roleId && user.tenantId) {
    const role = await RoleModel.findOne({ _id: user.roleId, tenantId: user.tenantId, isActive: true })
      .select('permissions')
      .lean();
    role?.permissions.forEach((p) => granted.add(p));
  }

  user.extraPermissions.forEach((p) => granted.add(p));
  // Explicit denials win over any grant.
  user.deniedPermissions.forEach((p) => granted.delete(p));

  return [...granted].filter((p): p is Permission => (ALL_PERMISSIONS as string[]).includes(p));
}

/** Verifies the access token and attaches a fully-resolved `req.auth`. */
export const authenticate = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized('Missing access token');

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (error) {
    const expired = (error as { name?: string }).name === 'TokenExpiredError';
    throw ApiError.unauthorized(expired ? 'Access token expired' : 'Invalid access token');
  }

  // A token without a well-formed subject is never looked up: an undefined id
  // would be dropped from the filter and match an arbitrary user.
  if (typeof payload.sub !== 'string' || !Types.ObjectId.isValid(payload.sub)) {
    throw ApiError.unauthorized('Invalid access token');
  }

  const user = await UserModel.findOne({ _id: payload.sub, deletedAt: null })
    .select('+passwordHash')
    .lean();

  if (!user) throw ApiError.unauthorized('Account no longer exists');
  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');

  // The workspace this session acts in. The signed token names it, but a token
  // is only a REQUEST: access is re-checked against account ownership on every
  // call, so losing ownership takes effect immediately. A 401 (not 403) sends
  // the client through a refresh, which returns the session to the home
  // workspace instead of trapping it in one it can no longer use.
  let tenantId = user.tenantId;
  let actor: WorkspaceActor | null = user.tenantId ? homeActor(user) : null;
  if (payload.tenantId && user.tenantId && payload.tenantId !== String(user.tenantId)) {
    if (!Types.ObjectId.isValid(payload.tenantId)) throw ApiError.unauthorized('Invalid access token');
    const requested = new Types.ObjectId(payload.tenantId);
    actor = await resolveActor(user, requested);
    if (!actor) throw ApiError.unauthorized('You no longer have access to this workspace');
    tenantId = requested;
  }

  // Role, grants and branches are those of the workspace being acted in: the
  // user record at home, account ownership or a membership elsewhere. A member
  // is therefore exactly as capable as their membership says, and no more.
  const permissions = await resolvePermissions(actor ? permissionSourceOf(actor) : user);

  const auth: AuthUser = {
    id: user._id,
    name: user.name,
    email: user.email,
    role: actor?.role ?? user.role,
    tenantId,
    storeId: actor?.storeId ?? null,
    storeAccess: actor?.storeAccess ?? [],
    permissions,
    isAdmin: actor?.isAdmin ?? false,
    isPlatformAdmin: user.role === ROLES.PLATFORM_ADMIN,
  };

  req.auth = auth;
  next();
});

/** Requires a platform-level administrator (no tenant scope). */
export const requirePlatformAdmin = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.auth) return next(ApiError.unauthorized());
  if (!req.auth.isPlatformAdmin) return next(ApiError.forbidden('Platform administrator access required'));
  next();
};

/** Requires the tenant owner/administrator role. */
export const requireTenantAdmin = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.auth) return next(ApiError.unauthorized());
  if (!req.auth.isAdmin) return next(ApiError.forbidden('Administrator access required'));
  next();
};
