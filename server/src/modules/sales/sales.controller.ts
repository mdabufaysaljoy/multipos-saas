import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { saleService } from './sales.service';
import type { CancelSaleInput, CreateSaleInput, ListSalesInput } from './sales.validators';

export const create = asyncHandler(async (req: Request, res: Response) => {
  created(res, await saleService.create(getContext(req), body<CreateSaleInput>(req)));
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const result = await saleService.list(getContext(req), query<ListSalesInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await saleService.getById(getContext(req), id));
});

export const getByNumber = asyncHandler(async (req: Request, res: Response) => {
  const { saleNumber } = params<{ saleNumber: string }>(req);
  ok(res, await saleService.getByNumber(getContext(req), saleNumber));
});

export const receipt = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await saleService.getReceipt(getContext(req), id));
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await saleService.cancel(getContext(req), id, body<CancelSaleInput>(req)));
});
