import type { Types } from 'mongoose';
import type { PosVertical } from '../../config/verticals';
import { ReturnModel } from '../../models/Return';
import { resolvePage, searchRegex } from '../../utils/pagination';
import type { TenantContext } from '../../types/express';

/**
 * The returns of the current branch, for a vertical that is not Clothing.
 *
 * One collection holds them all; `vertical` is what separates them, and
 * Clothing's own returns predate the field, so they are the ones without it.
 */
export async function listPosReturns(
  ctx: TenantContext,
  vertical: PosVertical,
  input: { page?: number; limit?: number; search?: string; saleId?: Types.ObjectId },
) {
  const { page, limit, skip } = resolvePage(input);
  const filter: Record<string, unknown> = { tenantId: ctx.tenantId, storeId: ctx.storeId, vertical };
  if (input.saleId) filter.saleId = input.saleId;
  if (input.search) {
    const rx = searchRegex(input.search);
    filter.$or = [{ returnNumber: rx }, { saleNumberSnapshot: rx }, { 'items.productNameSnapshot': rx }];
  }

  const [items, total] = await Promise.all([
    ReturnModel.find(filter).sort({ returnedAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    ReturnModel.countDocuments(filter),
  ]);
  return { items, page, limit, total };
}
