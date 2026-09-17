import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { StoreModel } from '../models/Store';
import { TenantModel } from '../models/Tenant';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import type { Permission } from '../config/permissions';
import type { TenantContext } from '../types/express';
import { DEFAULT_POS_VERTICAL } from '../config/verticals';
import { isPosVertical } from '../services/subscription/planEntitlements';

/**
 * Builds `req.ctx`, the tenant-scoped context every service call requires.
 *
 * This is the only place a tenantId enters the request lifecycle. It comes from
 * the authenticated user record - NEVER from a header, query string or body -
 * so one tenant cannot address another tenant's data by any client-side means.
 */
export const resolveTenant = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const auth = req.auth;
  if (!auth) throw ApiError.unauthorized();
  if (auth.isPlatformAdmin) {
    throw ApiError.forbidden('Platform administrators cannot access tenant POS endpoints directly');
  }
  if (!auth.tenantId) throw ApiError.forbidden('This account is not attached to a workspace');

  const tenant = await TenantModel.findById(auth.tenantId).select('status name vertical').lean();
  if (!tenant) throw ApiError.forbidden('Workspace not found');
  if (tenant.status === 'suspended') {
    throw ApiError.forbidden('This workspace has been suspended. Please contact support.');
  }

  // A branch may be chosen with a header, but ONLY among branches this tenant
  // owns AND this particular user is permitted to work in. Tenant admins reach
  // every branch; staff are limited to their home branch plus any explicitly
  // granted in `storeAccess`. Without this second check, any cashier could
  // switch branches simply by changing a request header.
  const requestedStoreId = req.header('x-store-id');
  let storeId: Types.ObjectId | null = auth.storeId;

  if (requestedStoreId) {
    if (!Types.ObjectId.isValid(requestedStoreId)) throw ApiError.badRequest('Invalid store id');
    const requested = new Types.ObjectId(requestedStoreId);

    const candidate = await StoreModel.findOne({ _id: requested, tenantId: auth.tenantId, isActive: true, deletedAt: null })
      .select('_id')
      .lean();
    if (!candidate) throw ApiError.forbidden('You do not have access to this branch');

    if (!auth.isAdmin && !isBranchAllowed(auth, requested)) {
      throw ApiError.forbidden('You are not assigned to this branch');
    }

    storeId = candidate._id;
  }

  // Without a header, the default branch comes from the user record. Confirm it
  // belongs to THIS workspace and is still open, otherwise fall back to the
  // workspace's main branch - a branch id must never carry one workspace's
  // context into another.
  if (storeId && !requestedStoreId) {
    const ownBranch = await StoreModel.exists({ _id: storeId, tenantId: auth.tenantId, isActive: true, deletedAt: null });
    if (!ownBranch) storeId = null;
  }

  if (!storeId) {
    const fallback = await StoreModel.findOne({ tenantId: auth.tenantId, isActive: true, deletedAt: null })
      .sort({ isDefault: -1, createdAt: 1 })
      .select('_id')
      .lean();
    if (!fallback) {
      throw new ApiError('NOT_FOUND', 'No store has been created for this workspace yet');
    }
    storeId = fallback._id;
  }

  const permissions = auth.permissions;
  const isAdmin = auth.isAdmin;

  const ctx: TenantContext = {
    tenantId: auth.tenantId,
    // From the workspace record, never the request. Legacy rows are Clothing.
    vertical: isPosVertical(tenant.vertical) ? tenant.vertical : DEFAULT_POS_VERTICAL,
    storeId,
    allowedStoreIds: isAdmin
      ? []
      : [auth.storeId, ...(auth.storeAccess ?? [])].filter((id): id is Types.ObjectId => Boolean(id)),
    userId: auth.id,
    userName: auth.name,
    role: auth.role,
    permissions,
    isAdmin,
    // Admins bypass granular permission checks by design.
    can: (permission: Permission) => isAdmin || permissions.includes(permission),
  };

  req.ctx = ctx;
  next();
});

/** Home branch plus explicitly granted branches. */
const isBranchAllowed = (auth: { storeId: Types.ObjectId | null; storeAccess?: Types.ObjectId[] }, storeId: Types.ObjectId) => {
  if (auth.storeId && String(auth.storeId) === String(storeId)) return true;
  return (auth.storeAccess ?? []).some((id) => String(id) === String(storeId));
};

/** Throws rather than returning undefined, so controllers can rely on it. */
export const getContext = (req: Request): TenantContext => {
  if (!req.ctx) throw ApiError.internal('Tenant context was not resolved for this route');
  return req.ctx;
};
