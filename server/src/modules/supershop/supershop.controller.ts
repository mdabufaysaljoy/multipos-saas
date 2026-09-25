import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { posReturnService } from '../../services/returns/posReturns.service';
import { listPosReturns } from '../../services/returns/posReturns.list';
import { supershopSaleReturnAdapter } from '../../services/returns/adapters/supershop.saleAdapter';
import { recordAudit } from '../../services/audit/audit.service';
import { supershopService } from './supershop.service';
import {
  shopBrandService,
  type CreateShopBrandInput,
  type ListShopBrandsInput,
  type UpdateShopBrandInput,
} from '../../services/catalogue/shopBrands.service';
import { supershopReportsService } from './supershopReports.service';
import { streamReportPdf } from '../../services/reports/reportPrint';
import { supershopReportView } from '../../services/reports/reportViews';
import { storeCurrency } from '../../services/reports/storeCurrency';
import type { AnalyticsRangeInput, DashboardRangeInput } from '../reports/reports.validators';
import type {
  AdjustStockInput,
  CreateProductInput,
  CreateSaleInput,
  ListMovementsInput,
  ListProductsInput,
  ListSalesInput,
  ReceiveStockInput,
  UpdateProductInput,
  CreateReturnInput,
  CreateExchangeInput,
} from './supershop.validators';

type IdParams = { id: Types.ObjectId };

// -------------------------------------------------------------- products
export const listProducts = asyncHandler(async (req: Request, res: Response) => {
  const result = await supershopService.listProducts(getContext(req), query<ListProductsInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

// ---------------------------------------------------------------- brands
// The same four routes a department has, on the same design: the product keeps
// the name, this is the list of names, and renaming one rewrites the products.
export const listBrands = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await shopBrandService.list(getContext(req), query<ListShopBrandsInput>(req)));
});

export const createBrand = asyncHandler(async (req: Request, res: Response) => {
  created(res, await shopBrandService.create(getContext(req), body<CreateShopBrandInput>(req)));
});

export const updateBrand = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await shopBrandService.update(getContext(req), params<IdParams>(req).id, body<UpdateShopBrandInput>(req)));
});

export const removeBrand = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await shopBrandService.remove(getContext(req), params<IdParams>(req).id));
});

export const lookupBarcode = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await supershopService.lookupBarcode(getContext(req), query<{ barcode: string }>(req).barcode));
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

/** The cards above the inventory screen: what is on the shelf and what it is worth. */
export const inventorySummary = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await supershopService.inventorySummary(getContext(req)));
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

/**
 * A return against a completed sale: the money goes back on a tender the branch
 * takes, and the goods go back where this vertical keeps them.
 */
export const createReturn = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<CreateReturnInput>(req);
  const result = await posReturnService.create(ctx, supershopSaleReturnAdapter, { saleId: id, ...input });
  await recordAudit(req, {
    action: 'supershop.sale_returned',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: result.returnNumber,
    newValue: { saleNumber: result.saleNumberSnapshot, totalMinor: result.totalMinor, reason: result.reason },
  });
  created(res, result);
});

/**
 * An exchange: goods back, goods out, and the difference paid at the till.
 * The engine re-values both sides on the server and refuses a cheaper swap.
 */
export const createExchange = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<CreateExchangeInput>(req);
  const result = await posReturnService.createExchange(ctx, supershopSaleReturnAdapter, {
    saleId: params<IdParams>(req).id,
    items: input.items,
    reason: input.reason,
    replacement: {
      items: input.replacement.items.map((item) => ({ itemId: item.productId, quantity: item.quantity })),
      payments: input.replacement.payments,
    },
    idempotencyKey: input.idempotencyKey,
  });
  await recordAudit(req, {
    action: 'supershop.sale_exchanged',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: result.returnNumber,
    newValue: {
      returnId: String(result._id),
      creditMinor: result.totalMinor,
      replacementSaleId: String(result.exchange?.saleId ?? ''),
      extraPayableMinor: result.exchange?.extraPayableMinor ?? 0,
    },
  });
  // A replay is the same exchange, not a new one.
  created(res, result);
});

export const listReturns = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await listPosReturns(ctx, 'supershop', query<{ page?: number; limit?: number; search?: string }>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const dashboard = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await supershopService.dashboard(getContext(req), query<DashboardRangeInput>(req)));
});

export const reports = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await supershopReportsService.report(getContext(req), query<AnalyticsRangeInput>(req)));
});

/** The same report as a PDF: what the screen shows, printed. */
export const printReports = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const data = await supershopReportsService.report(ctx, query<AnalyticsRangeInput>(req));
  await streamReportPdf(ctx, res, supershopReportView(data as unknown as Record<string, unknown>, await storeCurrency(ctx)));
});
