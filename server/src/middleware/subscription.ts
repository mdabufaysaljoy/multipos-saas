import type { NextFunction, Request, Response } from 'express';
import { entitlementService, type FeatureKey } from '../services/subscription/entitlement.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';

/**
 * Blocks write operations for tenants whose subscription has lapsed. Read
 * endpoints stay open so an expired tenant can still see their data (and pay).
 */
export const requireActiveSubscription = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const ctx = req.ctx;
  if (!ctx) throw ApiError.unauthorized();
  const entitlement = await entitlementService.forTenant(ctx.tenantId);
  entitlementService.assertUsable(entitlement);
  next();
});

/** Gates a route behind a plan feature flag. */
export const requireFeature = (feature: FeatureKey, label: string) =>
  asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const ctx = req.ctx;
    if (!ctx) throw ApiError.unauthorized();
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertUsable(entitlement);
    entitlementService.assertFeature(entitlement, feature, label);
    next();
  });
