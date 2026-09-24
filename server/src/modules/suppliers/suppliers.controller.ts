import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { PERMISSIONS } from '../../config/permissions';
import { getContext } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import { supplierService } from './suppliers.service';
import type { CreateSupplierInput, ListSuppliersInput, UpdateSupplierInput } from './suppliers.validators';

export const statusSchema = z.object({ isActive: z.boolean() }).strict();

/** Banking details are for the people who maintain them. */
const BANKING_PERMISSION = PERMISSIONS.SUPPLIERS_EDIT;

export const summary = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await supplierService.summary(getContext(req)));
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const result = await supplierService.list(getContext(req), query<ListSuppliersInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await supplierService.getById(getContext(req), id, BANKING_PERMISSION));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const supplier = await supplierService.create(ctx, body<CreateSupplierInput>(req), BANKING_PERMISSION);
  // Who added which supplier - never the banking or tax values themselves.
  await recordAudit(req, {
    action: 'supplier.created',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: `${supplier.code} ${supplier.name}`,
  });
  created(res, supplier);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<UpdateSupplierInput>(req);
  const supplier = await supplierService.update(ctx, id, input, BANKING_PERMISSION);
  await recordAudit(req, {
    action: 'supplier.updated',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: `${supplier.code} ${supplier.name}`,
    // The FIELDS that changed, so the log is useful without copying their values.
    newValue: { fields: Object.keys(input) },
  });
  ok(res, supplier);
});

export const setStatus = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const { isActive } = body<{ isActive: boolean }>(req);
  const supplier = await supplierService.setStatus(ctx, id, isActive);
  await recordAudit(req, {
    action: isActive ? 'supplier.reactivated' : 'supplier.deactivated',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: `${supplier.code} ${supplier.name}`,
  });
  ok(res, supplier);
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const result = await supplierService.remove(ctx, id);
  await recordAudit(req, {
    action: 'supplier.deleted',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: result.code,
  });
  ok(res, result);
});
