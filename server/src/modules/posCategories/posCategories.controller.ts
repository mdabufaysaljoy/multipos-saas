import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/apiResponse';
import { body, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import {
  posCategoryService,
  type CreatePosCategoryInput,
  type ListPosCategoriesInput,
  type UpdatePosCategoryInput,
} from '../../services/catalogue/posCategories.service';

/**
 * Managing the departments a workspace sells under, for the POS types whose
 * items carry the category as a name. Mounted by each of those modules at
 * `/categories`, so one client screen serves all three.
 */
export const listCategories = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, await posCategoryService.list(ctx, ctx.vertical, query<ListPosCategoriesInput>(req)));
});

export const createCategory = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  created(res, await posCategoryService.create(ctx, ctx.vertical, body<CreatePosCategoryInput>(req)));
});

export const updateCategory = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, await posCategoryService.update(ctx, ctx.vertical, new Types.ObjectId(req.params.id), body<UpdatePosCategoryInput>(req)));
});

export const removeCategory = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, await posCategoryService.remove(ctx, ctx.vertical, new Types.ObjectId(req.params.id)));
});
