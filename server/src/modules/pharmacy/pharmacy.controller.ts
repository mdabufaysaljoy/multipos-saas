import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { posReturnService } from '../../services/returns/posReturns.service';
import { listPosReturns } from '../../services/returns/posReturns.list';
import { pharmacySaleReturnAdapter } from '../../services/returns/adapters/pharmacy.saleAdapter';
import { recordAudit } from '../../services/audit/audit.service';
import { pharmacyService } from './pharmacy.service';
import {
  pharmacyManufacturerService,
  type CreatePharmacyManufacturerInput,
  type ListPharmacyManufacturersInput,
  type UpdatePharmacyManufacturerInput,
} from '../../services/catalogue/pharmacyManufacturers.service';
import { pharmacyReportsService } from './pharmacyReports.service';
import { pharmacyShiftsService } from './pharmacyShifts.service';
import { streamReportPdf } from '../../services/reports/reportPrint';
import { pharmacyReportView } from '../../services/reports/reportViews';
import { storeCurrency } from '../../services/reports/storeCurrency';
import type { AnalyticsRangeInput, DashboardRangeInput } from '../reports/reports.validators';
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
  CreateReturnInput,
  CreateExchangeInput,
  CashMovementInput,
  CloseShiftInput,
  ListShiftsInput,
  OpenShiftInput,
} from './pharmacy.validators';

type IdParams = { id: Types.ObjectId };

export const listManufacturers = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pharmacyManufacturerService.list(getContext(req), query<ListPharmacyManufacturersInput>(req)));
});

export const createManufacturer = asyncHandler(async (req: Request, res: Response) => {
  created(res, await pharmacyManufacturerService.create(getContext(req), body<CreatePharmacyManufacturerInput>(req)));
});

export const updateManufacturer = asyncHandler(async (req: Request, res: Response) => {
  ok(
    res,
    await pharmacyManufacturerService.update(
      getContext(req),
      params<IdParams>(req).id,
      body<UpdatePharmacyManufacturerInput>(req),
    ),
  );
});

export const removeManufacturer = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pharmacyManufacturerService.remove(getContext(req), params<IdParams>(req).id));
});

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

/**
 * A return against a completed sale: the money goes back on a tender the branch
 * takes, and the goods go back where this vertical keeps them.
 */
export const createReturn = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<CreateReturnInput>(req);
  const result = await posReturnService.create(ctx, pharmacySaleReturnAdapter, { saleId: id, ...input });
  await recordAudit(req, {
    action: 'pharmacy.sale_returned',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: result.returnNumber,
    newValue: { saleNumber: result.saleNumberSnapshot, totalMinor: result.totalMinor, reason: result.reason },
  });
  created(res, result);
});

export const listReturns = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await listPosReturns(ctx, 'pharmacy', query<{ page?: number; limit?: number; search?: string }>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const medicineFilters = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pharmacyService.medicineFilters(getContext(req)));
});

export const currentShift = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pharmacyShiftsService.current(getContext(req)));
});

export const openShift = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await pharmacyShiftsService.open(ctx, body<OpenShiftInput>(req));
  await recordAudit(req, { action: 'pharmacy.shift.opened', targetTenantId: ctx.tenantId, targetStoreId: ctx.storeId, targetLabel: result.shift.shiftNumber, newValue: { openingFloatMinor: result.shift.openingFloatMinor } });
  created(res, result);
});

export const createExchange = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<CreateExchangeInput>(req);
  const result = await posReturnService.createExchange(ctx, pharmacySaleReturnAdapter, {
    saleId: params<IdParams>(req).id,
    items: input.items,
    reason: input.reason,
    replacement: {
      items: input.replacement.items.map((item) => ({ itemId: item.medicineId, quantity: item.quantity })),
      payments: input.replacement.payments,
    },
    idempotencyKey: input.idempotencyKey,
  });
  await recordAudit(req, {
    action: 'pharmacy.sale_exchanged',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: result.returnNumber,
    newValue: {
      originalSale: result.saleNumberSnapshot,
      replacementSale: result.exchange?.saleNumber,
      creditMinor: result.exchange?.refundableMinor,
      extraPaidMinor: result.exchange?.extraPayableMinor,
      reason: input.reason,
    },
  });
  created(res, result);
});

export const addCashMovement = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<CashMovementInput>(req);
  const result = await pharmacyShiftsService.addCashMovement(ctx, params<IdParams>(req).id, input);
  await recordAudit(req, { action: `pharmacy.shift.${input.type}`, targetTenantId: ctx.tenantId, targetStoreId: ctx.storeId, targetLabel: result.shift.shiftNumber, newValue: { amountMinor: input.amountMinor, reason: input.reason } });
  ok(res, result);
});

export const closeShift = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await pharmacyShiftsService.close(ctx, params<IdParams>(req).id, body<CloseShiftInput>(req));
  await recordAudit(req, { action: 'pharmacy.shift.closed', targetTenantId: ctx.tenantId, targetStoreId: ctx.storeId, targetLabel: result.shift.shiftNumber, newValue: { expectedCashMinor: result.shift.expectedCashMinor, countedCashMinor: result.shift.countedCashMinor, varianceMinor: result.shift.varianceMinor } });
  ok(res, result);
});

export const listShifts = asyncHandler(async (req: Request, res: Response) => {
  const result = await pharmacyShiftsService.list(getContext(req), query<ListShiftsInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getShift = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pharmacyShiftsService.get(getContext(req), params<IdParams>(req).id));
});

export const dashboard = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pharmacyService.dashboard(getContext(req), query<DashboardRangeInput>(req)));
});

export const reports = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await pharmacyReportsService.report(getContext(req), query<AnalyticsRangeInput>(req)));
});

/** The same report as a PDF: what the screen shows, printed. */
export const printReports = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const data = await pharmacyReportsService.report(ctx, query<AnalyticsRangeInput>(req));
  await streamReportPdf(ctx, res, pharmacyReportView(data as unknown as Record<string, unknown>, await storeCurrency(ctx)));
});
