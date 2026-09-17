import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { recordAudit } from '../../services/audit/audit.service';
import { pharmacyService } from './pharmacy.service';
import { pharmacyReportsService } from './pharmacyReports.service';
import type { AnalyticsRangeInput } from '../reports/reports.validators';
import type {
  AdjustBatchInput,
  CreateMedicineInput,
  CreateSaleInput,
  ListBatchesInput,
  ListMedicinesInput,
  ListMovementsInput,
  ListSalesInput,
  ReceiveBatchInput,
  UpdateMedicineInput,
} from './pharmacy.validators';

type IdParams = { id: Types.ObjectId };

// ------------------------------------------------------------- medicines
export const listMedicines = asyncHandler(async (req: Request, res: Response) => {
  const result = await pharmacyService.listMedicines(getContext(req), query<ListMedicinesInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getMedicine = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pharmacyService.getMedicine(getContext(req), params<IdParams>(req).id));
});

export const createMedicine = asyncHandler(async (req: Request, res: Response) => {
  created(res, await pharmacyService.createMedicine(getContext(req), body<CreateMedicineInput>(req)));
});

export const updateMedicine = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { before, after } = await pharmacyService.updateMedicine(ctx, params<IdParams>(req).id, body<UpdateMedicineInput>(req));
  if (before.sellingPriceMinor !== after.sellingPriceMinor) {
    await recordAudit(req, {
      action: 'pharmacy.medicine_price_changed',
      targetTenantId: ctx.tenantId,
      targetLabel: after.name,
      oldValue: { sellingPriceMinor: before.sellingPriceMinor },
      newValue: { sellingPriceMinor: after.sellingPriceMinor },
    });
  }
  ok(res, after);
});

export const removeMedicine = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pharmacyService.removeMedicine(getContext(req), params<IdParams>(req).id));
});

// ----------------------------------------------------------------- stock
export const receiveBatch = asyncHandler(async (req: Request, res: Response) => {
  created(res, await pharmacyService.receiveBatch(getContext(req), params<IdParams>(req).id, body<ReceiveBatchInput>(req)));
});

export const listBatches = asyncHandler(async (req: Request, res: Response) => {
  const result = await pharmacyService.listBatches(getContext(req), query<ListBatchesInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const adjustBatch = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<AdjustBatchInput>(req);
  const result = await pharmacyService.adjustBatch(ctx, params<IdParams>(req).id, input);
  await recordAudit(req, {
    action: 'pharmacy.stock_adjusted',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: `${result.medicineName} ${result.batch.batchNumber}`.trim(),
    oldValue: { quantityOnHand: result.previousOnHand },
    newValue: { quantityOnHand: result.batch.quantityOnHand, type: input.type, quantityDelta: input.quantityDelta, reason: input.reason },
  });
  ok(res, result);
});

export const listMovements = asyncHandler(async (req: Request, res: Response) => {
  const result = await pharmacyService.listMovements(getContext(req), query<ListMovementsInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

// ----------------------------------------------------------------- sales
export const createSale = asyncHandler(async (req: Request, res: Response) => {
  created(res, await pharmacyService.createSale(getContext(req), body<CreateSaleInput>(req)));
});

export const listSales = asyncHandler(async (req: Request, res: Response) => {
  const result = await pharmacyService.listSales(getContext(req), query<ListSalesInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getSale = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pharmacyService.getSale(getContext(req), params<IdParams>(req).id));
});

export const receipt = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pharmacyService.receipt(getContext(req), params<IdParams>(req).id));
});

export const voidSale = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { reason } = body<{ reason: string }>(req);
  const sale = await pharmacyService.voidSale(ctx, params<IdParams>(req).id, reason);
  await recordAudit(req, {
    action: 'pharmacy.sale_voided',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: sale.saleNumber,
    oldValue: { status: 'completed', totalMinor: sale.totalMinor },
    newValue: { status: 'voided', reason },
  });
  ok(res, sale);
});

export const dashboard = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pharmacyService.dashboard(getContext(req)));
});

export const reports = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pharmacyReportsService.report(getContext(req), query<AnalyticsRangeInput>(req)));
});
