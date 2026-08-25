import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { staffService } from './staff.service';
import type { CreateStaffInput, ListStaffInput, ResetStaffPasswordInput, UpdateStaffInput } from './staff.validators';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const result = await staffService.list(getContext(req), query<ListStaffInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await staffService.getById(getContext(req), id));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  created(res, await staffService.create(getContext(req), body<CreateStaffInput>(req)));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await staffService.update(getContext(req), id, body<UpdateStaffInput>(req)));
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await staffService.resetPassword(getContext(req), id, body<ResetStaffPasswordInput>(req)));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await staffService.remove(getContext(req), id));
});
