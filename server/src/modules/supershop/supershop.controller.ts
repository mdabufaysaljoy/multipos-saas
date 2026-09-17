import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { recordAudit } from '../../services/audit/audit.service';
import { supershopService } from './supershop.service';
import { supershopReportsService } from './supershopReports.service';
import type { AnalyticsRangeInput } from '../reports/reports.validators';
import type {
  AdjustStockInput,
  CreateProductInput,
  CreateSaleInput,
  ListMovementsInput,
  ListProductsInput,
  ListSalesInput,
  ReceiveStockInput,
  UpdateProductInput,
} from './supershop.validators';

type IdParams = { id: Types.ObjectId };

// -------------------------------------------------------------- products
export const listProducts = asyncHandler(async (req: Request, res: Response) => {
  const result = await supershopService.listProducts(getContext(req), query<ListProductsInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const lookupBarcode = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await supershopService.lookupBarcode(getContext(req), query<{ barcode: string }>(req).barcode));
});

export const categories = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await supershopService.categories(getContext(req)));
});

export const getProduct = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await supershopService.getProduct(getContext(req), params<IdParams>(req).id));
});

export const createProduct = asyncHandler(async (req: Request, res: Response) => {
  created(res, await supershopService.createProduct(getContext(req), body<CreateProductInput>(req)));
});

export const updateProduct = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { before, after } = await supershopService.updateProduct(ctx, params<IdParams>(req).id, body<UpdateProductInput>(req));
  if (before.priceMinor !== after.priceMinor || before.vatRateBps !== after.vatRateBps) {
    await recordAudit(req, {
      action: 'supershop.product_price_changed',
      targetTenantId: ctx.tenantId,
      targetLabel: after.name,
      oldValue: { priceMinor: before.priceMinor, vatRateBps: before.vatRateBps },
      newValue: { priceMinor: after.priceMinor, vatRateBps: after.vatRateBps },
    });
  }
  ok(res, after);
});

export const removeProduct = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await supershopService.removeProduct(getContext(req), params<IdParams>(req).id));
});

// ----------------------------------------------------------------- stock
export const receiveStock = asyncHandler(async (req: Request, res: Response) => {
  created(res, await supershopService.receiveStock(getContext(req), params<IdParams>(req).id, body<ReceiveStockInput>(req)));
});

export const adjustStock = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<AdjustStockInput>(req);
  const result = await supershopService.adjustStock(ctx, params<IdParams>(req).id, input);
  await recordAudit(req, {
    action: 'supershop.stock_adjusted',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: result.product.name,
    oldValue: { quantityOnHand: result.previousOnHand },
    newValue: { quantityOnHand: result.stock.quantityOnHand, type: input.type, quantityDelta: input.quantityDelta, reason: input.reason },
  });
  ok(res, result);
});

export const listMovements = asyncHandler(async (req: Request, res: Response) => {
  const result = await supershopService.listMovements(getContext(req), query<ListMovementsInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

// ----------------------------------------------------------------- sales
export const createSale = asyncHandler(async (req: Request, res: Response) => {
  created(res, await supershopService.createSale(getContext(req), body<CreateSaleInput>(req)));
});

export const listSales = asyncHandler(async (req: Request, res: Response) => {
  const result = await supershopService.listSales(getContext(req), query<ListSalesInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getSale = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await supershopService.getSale(getContext(req), params<IdParams>(req).id));
});

export const receipt = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await supershopService.receipt(getContext(req), params<IdParams>(req).id));
});

export const voidSale = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { reason } = body<{ reason: string }>(req);
  const sale = await supershopService.voidSale(ctx, params<IdParams>(req).id, reason);
  await recordAudit(req, {
    action: 'supershop.sale_voided',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: sale.saleNumber,
    oldValue: { status: 'completed', totalMinor: sale.totalMinor },
    newValue: { status: 'voided', reason },
  });
  ok(res, sale);
});

export const dashboard = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await supershopService.dashboard(getContext(req)));
});

export const reports = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await supershopReportsService.report(getContext(req), query<AnalyticsRangeInput>(req)));
});
