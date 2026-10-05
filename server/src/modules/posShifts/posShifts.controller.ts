import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { recordAudit } from '../../services/audit/audit.service';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { posShiftsService } from './posShifts.service';
import type {
  ClosePosShiftInput,
  ListPosShiftsInput,
  OpenPosShiftInput,
  PosCashMovementInput,
} from './posShifts.validators';

type IdParams = { id: Types.ObjectId };

export const current = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await posShiftsService.current(getContext(req)));
});

export const open = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await posShiftsService.open(ctx, body<OpenPosShiftInput>(req));
  await recordAudit(req, {
    action: `${ctx.vertical}.shift.opened`,
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: result.shift.shiftNumber,
    newValue: { openingFloatMinor: result.shift.openingFloatMinor },
  });
  created(res, result);
});

export const addCashMovement = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<PosCashMovementInput>(req);
  const result = await posShiftsService.addCashMovement(ctx, params<IdParams>(req).id, input);
  await recordAudit(req, {
    action: `${ctx.vertical}.shift.${input.type}`,
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: result.shift.shiftNumber,
    newValue: { amountMinor: input.amountMinor, reason: input.reason },
  });
  ok(res, result);
});

export const close = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await posShiftsService.close(ctx, params<IdParams>(req).id, body<ClosePosShiftInput>(req));
  await recordAudit(req, {
    action: `${ctx.vertical}.shift.closed`,
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: result.shift.shiftNumber,
    newValue: {
      expectedCashMinor: result.shift.expectedCashMinor,
      countedCashMinor: result.shift.countedCashMinor,
      varianceMinor: result.shift.varianceMinor,
    },
  });
  ok(res, result);
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const result = await posShiftsService.list(getContext(req), query<ListPosShiftsInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await posShiftsService.get(getContext(req), params<IdParams>(req).id));
});
