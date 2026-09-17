import type { NextFunction, Request, Response } from 'express';
import type { FeatureEntitlementKey } from '../config/entitlements';
import type { Permission } from '../config/permissions';
import { assertEntitlement } from '../services/entitlements/entitlementEngine';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

/**
 * Effective access = the SUBSCRIPTION grants the entitlement AND the USER's role
 * grants the permission. Both are checked on every request, on the server; the
 * frontend only decides what to show.
 *
 *   subscription refuses -> the entitlement's code (e.g. ADVANCED_ANALYTICS_REQUIRED)
 *   role refuses         -> 403 FORBIDDEN
 */
export const requireAccess = (options: { entitlement?: FeatureEntitlementKey; permission?: Permission | Permission[] }) =>
  asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const ctx = req.ctx;
    if (!ctx) throw ApiError.unauthorized();

    if (options.entitlement) await assertEntitlement(ctx.tenantId, options.entitlement);

    const required = options.permission ? (Array.isArray(options.permission) ? options.permission : [options.permission]) : [];
    const missing = ctx.isAdmin ? [] : required.filter((permission) => !ctx.permissions.includes(permission));
    if (missing.length > 0) throw ApiError.forbidden(`You need the "${missing.join('", "')}" permission to do this`);
    next();
  });

/** A route gated by a subscription entitlement only (the permission is checked separately). */
export const requireEntitlement = (entitlement: FeatureEntitlementKey) => requireAccess({ entitlement });
