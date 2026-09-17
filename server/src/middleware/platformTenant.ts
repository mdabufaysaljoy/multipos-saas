import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { ALL_PERMISSIONS } from '../config/permissions';
import { StoreModel } from '../models/Store';
import { TenantModel } from '../models/Tenant';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import type { TenantContext } from '../types/express';
import { DEFAULT_POS_VERTICAL } from '../config/verticals';
import { isPosVertical } from '../services/subscription/planEntitlements';

/**
 * Builds a tenant context for a PLATFORM ADMIN acting on a named workspace.
 *
 * This is the only way platform admins reach tenant data, and it demands an
 * explicit `tenantId` every time. Ordinary tenant endpoints keep using
 * `resolveTenant`, which derives the tenant from the signed-in user and refuses
 * platform admins outright - so a platform admin can never accidentally pull
 * cross-tenant data through a normal route.
 *
 * The resulting context carries every permission, because a platform admin
 * operating inside a workspace is doing setup/support work on the owner's
 * behalf. The authorisation that matters happened at the route: platform-admin
 * role + an explicit target tenant.
 */
export const resolvePlatformTenant = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const auth = req.auth;
  if (!auth) throw ApiError.unauthorized();
  if (!auth.isPlatformAdmin) throw ApiError.forbidden('Platform administrator access required');

  const raw =
    (req.params as Record<string, string>).tenantId ??
    (req.query as Record<string, string>).tenantId ??
    (req.body as Record<string, string> | undefined)?.tenantId ??
    req.header('x-target-tenant-id');

  if (!raw || !Types.ObjectId.isValid(raw)) {
    throw ApiError.badRequest('A target workspace must be specified for this operation');
  }

  const tenantId = new Types.ObjectId(raw);
  const tenant = await TenantModel.findById(tenantId).select('_id name vertical').lean();
  if (!tenant) throw ApiError.notFound('Workspace not found');

  // An explicit branch may be given; otherwise fall back to the main one.
  const rawStore =
    (req.params as Record<string, string>).storeId ??
    (req.query as Record<string, string>).storeId ??
    (req.body as Record<string, string> | undefined)?.storeId ??
    req.header('x-target-store-id');

  let storeId: Types.ObjectId | null = null;

  if (rawStore && Types.ObjectId.isValid(rawStore)) {
    const store = await StoreModel.findOne({ _id: new Types.ObjectId(rawStore), tenantId, deletedAt: null }).select('_id').lean();
    if (!store) throw ApiError.badRequest('That branch does not belong to the selected workspace');
    storeId = store._id;
  } else {
    const fallback = await StoreModel.findOne({ tenantId, deletedAt: null })
      .sort({ isDefault: -1, createdAt: 1 })
      .select('_id')
      .lean();
    storeId = fallback?._id ?? null;
  }

  if (!storeId) throw ApiError.badRequest('This workspace has no store yet. Create one first.');

  const ctx: TenantContext = {
    tenantId,
    vertical: isPosVertical(tenant.vertical) ? tenant.vertical : DEFAULT_POS_VERTICAL,
    storeId,
    userId: auth.id,
    userName: `${auth.name} (platform admin)`,
    role: auth.role,
    permissions: [...ALL_PERMISSIONS],
    isAdmin: true,
    can: () => true,
  };

  req.ctx = ctx;
  next();
});
