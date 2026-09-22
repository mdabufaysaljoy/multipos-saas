import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { returnService } from './returns.service';
import { EXCHANGE_REFUND_METHOD, type CreateReturnInput, type ListReturnsInput } from './returns.validators';
import { PERMISSIONS } from '../../config/permissions';
import { ApiError } from '../../utils/ApiError';

export const create = asyncHandler(async (req: Request, res: Response) => {
  const input = body<CreateReturnInput>(req);
  const ctx = getContext(req);
  if (input.refundMethod === EXCHANGE_REFUND_METHOD) {
    // An exchange also SELLS the replacement goods, so it needs the permission to sell.
    if (!ctx.can(PERMISSIONS.SALES_CREATE)) {
      throw ApiError.forbidden('Exchanging needs permission to create sales as well as returns');
    }
    const result = await returnService.createExchange(ctx, input);
    const replayed = Boolean((result as { replayed?: boolean }).replayed);
    return replayed ? ok(res, result) : created(res, result);
  }
  created(res, await returnService.create(ctx, input));
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
