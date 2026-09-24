import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { getContext } from '../../middleware/tenant';
import { body, params } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { created, ok } from '../../utils/apiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import { paymentMethodService } from './paymentMethods.service';
import type { CreatePaymentMethodInput, UpdatePaymentMethodInput } from './paymentMethods.validators';

export const list = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await paymentMethodService.list(getContext(req)));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const method = await paymentMethodService.create(ctx, body<CreatePaymentMethodInput>(req));
  await recordAudit(req, {
    action: 'payment_method.created',
    targetTenantId: ctx.tenantId,
    targetLabel: method.label,
    newValue: { key: method.key, label: method.label },
  });
  created(res, method);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<UpdatePaymentMethodInput>(req);
  const method = await paymentMethodService.update(ctx, id, input);
  await recordAudit(req, {
    action: 'payment_method.updated',
    targetTenantId: ctx.tenantId,
    targetLabel: method.label,
    newValue: { key: method.key, label: method.label, isActive: method.isActive },
  });
  ok(res, method);
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const result = await paymentMethodService.remove(ctx, id);
  await recordAudit(req, { action: 'payment_method.deleted', targetTenantId: ctx.tenantId, targetLabel: String(id) });
  ok(res, result);
});
