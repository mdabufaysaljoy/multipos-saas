import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { categoryService } from './categories.service';
import type { CreateCategoryInput, ListCategoriesInput, UpdateCategoryInput } from './categories.validators';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const result = await categoryService.list(getContext(req), query<ListCategoriesInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await categoryService.getById(getContext(req), id));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  created(res, await categoryService.create(getContext(req), body<CreateCategoryInput>(req)));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await categoryService.update(getContext(req), id, body<UpdateCategoryInput>(req)));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await categoryService.remove(getContext(req), id));
});
