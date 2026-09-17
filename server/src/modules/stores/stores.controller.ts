import type { Request, Response } from 'express';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/apiResponse';
import { body, params } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { storeService } from './stores.service';
import type { CreateStoreInput, UpdateStoreInput } from './stores.validators';

export const list = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth?.tenantId) throw ApiError.forbidden('You do not belong to a workspace');
  ok(res, await storeService.list(req.auth.tenantId));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw ApiError.unauthorized();
  created(res, await storeService.create(req.auth, body<CreateStoreInput>(req)));
});

export const getCurrent = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, await storeService.getById(ctx.tenantId, ctx.storeId));
});

/** Readable by any authenticated tenant user - the POS depends on it. */
export const posConfig = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, await storeService.posConfig(ctx.tenantId, ctx.storeId));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: import('mongoose').Types.ObjectId }>(req);
  ok(res, await storeService.update(ctx, id, body<UpdateStoreInput>(req)));
});

export const updateCurrent = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, await storeService.update(ctx, ctx.storeId, body<UpdateStoreInput>(req)));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: import('mongoose').Types.ObjectId }>(req);
  ok(res, await storeService.remove(ctx, id));
});

export const makeDefault = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: import('mongoose').Types.ObjectId }>(req);
  ok(res, await storeService.makeDefault(ctx, id));
});
