import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { returnService } from './returns.service';
import type { CreateReturnInput, ListReturnsInput } from './returns.validators';

export const create = asyncHandler(async (req: Request, res: Response) => {
  created(res, await returnService.create(getContext(req), body<CreateReturnInput>(req)));
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const result = await returnService.list(getContext(req), query<ListReturnsInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await returnService.getById(getContext(req), id));
});

/** Powers the "start a return" screen: what is still returnable on a sale. */
export const returnableSale = asyncHandler(async (req: Request, res: Response) => {
  const { saleId } = params<{ saleId: Types.ObjectId }>(req);
  ok(res, await returnService.getReturnableSale(getContext(req), saleId));
});
