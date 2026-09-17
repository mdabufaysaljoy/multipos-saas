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

/**
 * Locks a whole module when the workspace has no usable subscription.
 *
 * Stricter than `requireActiveSubscription`, which only blocks writes. This
 * blocks READS too, because an unsubscribed workspace should be able to reach
 * exactly two things: its wallet and its subscription - the means to pay, and
 * the thing to pay for. Everything else is inaccessible until they do.
 *
 * A trial still counts as usable: the free trial exists so a new customer can
 * evaluate the POS before paying.
 */
export const requireSubscribedAccess = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const ctx = req.ctx;
  if (!ctx) throw ApiError.unauthorized();

  const entitlement = await entitlementService.forTenant(ctx.tenantId);
  if (entitlement.isUsable) return next();

  throw ApiError.subscriptionInactive(
    entitlement.status === 'suspended'
      ? 'This workspace has been suspended. Contact support to restore access.'
      : 'Your subscription is not active. Add money to your wallet and choose a plan to unlock the POS.',
    {
      status: entitlement.status,
      currentPeriodEnd: entitlement.currentPeriodEnd,
      // Tells the client exactly where the customer is still allowed to go.
      allowedSections: ['wallet', 'subscription'],
    },
  );
});

/** Gates a route behind a plan feature flag. */
export const requireFeature = (feature: FeatureKey, label: string, code?: ConstructorParameters<typeof ApiError>[0]) =>
  asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const ctx = req.ctx;
    if (!ctx) throw ApiError.unauthorized();
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertUsable(entitlement);
    entitlementService.assertFeature(entitlement, feature, label, code);
    next();
  });
