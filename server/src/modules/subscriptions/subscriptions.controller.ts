import type { Request, Response } from 'express';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/apiResponse';
import { body } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { subscriptionService } from './subscriptions.service';
import type { CancelSubscriptionInput } from './subscriptions.validators';

/** The tenant's own subscription screen. */
export const current = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, await subscriptionService.current(ctx.tenantId));
});

export const history = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, await subscriptionService.history(ctx.tenantId));
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  if (!req.auth) throw ApiError.unauthorized();
  const result = await subscriptionService.cancel(ctx.tenantId, body<CancelSubscriptionInput>(req), {
    id: req.auth.id,
    name: req.auth.name,
  });
  ok(res, result);
});

export const reactivate = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  if (!req.auth) throw ApiError.unauthorized();
  ok(res, await subscriptionService.reactivate(ctx.tenantId, { id: req.auth.id, name: req.auth.name }));
});
