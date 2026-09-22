import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { getContext } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import { loyaltyService } from './loyalty.service';
import type { AdjustPointsInput, IssueMembershipInput, ListMembershipsInput, SetStatusInput } from './loyalty.validators';

export const summary = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await loyaltyService.summary(getContext(req)));
});

export const lookup = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await loyaltyService.lookup(getContext(req), query<{ code: string }>(req).code));
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const result = await loyaltyService.list(getContext(req), query<ListMembershipsInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await loyaltyService.getById(getContext(req), params<{ id: Types.ObjectId }>(req).id));
});

export const forCustomer = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await loyaltyService.forCustomer(getContext(req), params<{ customerId: Types.ObjectId }>(req).customerId));
});

export const history = asyncHandler(async (req: Request, res: Response) => {
  const result = await loyaltyService.history(getContext(req), params<{ id: Types.ObjectId }>(req).id, query<{ page: number; limit: number }>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const issue = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await loyaltyService.issue(ctx, body<IssueMembershipInput>(req));
  if ('replayed' in result && result.replayed) return ok(res, result);
  await recordAudit(req, {
    action: 'loyalty.card_issued',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: result.cardNumber,
    newValue: { customerId: result.customer?.id, feeMinor: result.membershipFeeMinor },
  });
  created(res, result);
});

export const setStatus = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<SetStatusInput>(req);
  const result = await loyaltyService.setStatus(ctx, params<{ id: Types.ObjectId }>(req).id, input);
  await recordAudit(req, { action: `loyalty.card_${input.status === 'active' ? 'activated' : 'deactivated'}`, targetTenantId: ctx.tenantId, targetStoreId: ctx.storeId, targetLabel: result.cardNumber, newValue: { reason: input.reason } });
  ok(res, result);
});

export const adjust = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<AdjustPointsInput>(req);
  const result = await loyaltyService.adjust(ctx, params<{ id: Types.ObjectId }>(req).id, input);
  await recordAudit(req, { action: 'loyalty.points_adjusted', targetTenantId: ctx.tenantId, targetStoreId: ctx.storeId, targetLabel: result.cardNumber, newValue: { points: input.points, reason: input.reason } });
  ok(res, result);
});
