import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { StoreModel } from '../models/Store';
import { TenantModel } from '../models/Tenant';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import type { Permission } from '../config/permissions';
import type { TenantContext } from '../types/express';

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

  const tenant = await TenantModel.findById(auth.tenantId).select('status name').lean();
  if (!tenant) throw ApiError.forbidden('Workspace not found');
  if (tenant.status === 'suspended') {
    throw ApiError.forbidden('This workspace has been suspended. Please contact support.');
  }

  // A store may be chosen with a header, but only among stores this tenant owns.
  const requestedStoreId = req.header('x-store-id');
  let storeId: Types.ObjectId | null = auth.storeId;

  if (requestedStoreId) {
    if (!Types.ObjectId.isValid(requestedStoreId)) throw ApiError.badRequest('Invalid store id');
    const candidate = await StoreModel.findOne({
      _id: new Types.ObjectId(requestedStoreId),
      tenantId: auth.tenantId,
      isActive: true,
    })
      .select('_id')
      .lean();
    if (!candidate) throw ApiError.forbidden('You do not have access to this store');
    storeId = candidate._id;
  }

  if (!storeId) {
    const fallback = await StoreModel.findOne({ tenantId: auth.tenantId, isActive: true })
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
    storeId,
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

/** Throws rather than returning undefined, so controllers can rely on it. */
export const getContext = (req: Request): TenantContext => {
  if (!req.ctx) throw ApiError.internal('Tenant context was not resolved for this route');
  return req.ctx;
};
