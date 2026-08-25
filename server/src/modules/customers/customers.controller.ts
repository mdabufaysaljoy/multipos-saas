import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { customerService } from './customers.service';
import type { CreateCustomerInput, ListCustomersInput, UpdateCustomerInput } from './customers.validators';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const result = await customerService.list(getContext(req), query<ListCustomersInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await customerService.getById(getContext(req), id));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  created(res, await customerService.create(getContext(req), body<CreateCustomerInput>(req)));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await customerService.update(getContext(req), id, body<UpdateCustomerInput>(req)));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await customerService.remove(getContext(req), id));
});
