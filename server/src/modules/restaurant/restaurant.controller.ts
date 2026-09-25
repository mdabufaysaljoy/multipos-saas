import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { posReturnService } from '../../services/returns/posReturns.service';
import { listPosReturns } from '../../services/returns/posReturns.list';
import { restaurantSaleReturnAdapter } from '../../services/returns/adapters/restaurant.saleAdapter';
import { recordAudit } from '../../services/audit/audit.service';
import { restaurantService } from './restaurant.service';
import { restaurantReportsService } from './restaurantReports.service';
import { streamReportPdf } from '../../services/reports/reportPrint';
import { restaurantReportView } from '../../services/reports/reportViews';
import { storeCurrency } from '../../services/reports/storeCurrency';
import { shiftService } from './shifts.service';
import type {
  CashMovementInput,
  CloseShiftInput,
  ListShiftsInput,
  OpenShiftInput,
  DashboardInput,
  KitchenQueueInput,
  CreateMenuItemInput,
  CreateOrderInput,
  CreateTableInput,
  ListMenuInput,
  ListOrdersInput,
  OrderLineInput,
  PayOrderInput,
  SummaryInput,
  UpdateMenuItemInput,
  UpdateTableInput,
  CreateOrderReturnInput,
} from './restaurant.validators';

type IdParams = { id: Types.ObjectId };
type LineParams = { id: Types.ObjectId; lineId: Types.ObjectId };
type TicketParams = { id: Types.ObjectId; ticketId: Types.ObjectId };

// ----------------------------------------------------------------- menu
export const listMenu = asyncHandler(async (req: Request, res: Response) => {
  const result = await restaurantService.listMenu(getContext(req), query<ListMenuInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const createMenuItem = asyncHandler(async (req: Request, res: Response) => {
  created(res, await restaurantService.createMenuItem(getContext(req), body<CreateMenuItemInput>(req)));
});

export const updateMenuItem = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantService.updateMenuItem(getContext(req), params<IdParams>(req).id, body<UpdateMenuItemInput>(req)));
});

export const removeMenuItem = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantService.removeMenuItem(getContext(req), params<IdParams>(req).id));
});

// --------------------------------------------------------------- tables
export const listTables = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantService.listTables(getContext(req)));
});

export const createTable = asyncHandler(async (req: Request, res: Response) => {
  created(res, await restaurantService.createTable(getContext(req), body<CreateTableInput>(req)));
});

export const updateTable = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantService.updateTable(getContext(req), params<IdParams>(req).id, body<UpdateTableInput>(req)));
});

export const removeTable = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantService.removeTable(getContext(req), params<IdParams>(req).id));
});

// --------------------------------------------------------------- orders
export const listOrders = asyncHandler(async (req: Request, res: Response) => {
  const result = await restaurantService.listOrders(getContext(req), query<ListOrdersInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getOrder = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantService.getOrder(getContext(req), params<IdParams>(req).id));
});

export const createOrder = asyncHandler(async (req: Request, res: Response) => {
  created(res, await restaurantService.createOrder(getContext(req), body<CreateOrderInput>(req)));
});

export const addItems = asyncHandler(async (req: Request, res: Response) => {
  const input = body<{ items: OrderLineInput[] }>(req);
  ok(res, await restaurantService.addItems(getContext(req), params<IdParams>(req).id, input.items));
});

export const updateLine = asyncHandler(async (req: Request, res: Response) => {
  const { id, lineId } = params<LineParams>(req);
  ok(res, await restaurantService.updateLine(getContext(req), id, lineId, body<{ quantity: number }>(req).quantity));
});

export const removeLine = asyncHandler(async (req: Request, res: Response) => {
  const { id, lineId } = params<LineParams>(req);
  ok(res, await restaurantService.removeLine(getContext(req), id, lineId));
});

export const payOrder = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantService.payOrder(getContext(req), params<IdParams>(req).id, body<PayOrderInput>(req)));
});

export const cancelOrder = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantService.cancelOrder(getContext(req), params<IdParams>(req).id, body<{ reason: string }>(req).reason));
});

export const sendToKitchen = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantService.sendToKitchen(getContext(req), params<IdParams>(req).id, body<{ rev: number }>(req).rev));
});

export const kitchenQueue = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantService.kitchenQueue(getContext(req), query<KitchenQueueInput>(req).status));
});

export const markTicketReady = asyncHandler(async (req: Request, res: Response) => {
  const { id, ticketId } = params<TicketParams>(req);
  ok(res, await restaurantService.markTicketReady(getContext(req), id, ticketId));
});

export const kitchenTicket = asyncHandler(async (req: Request, res: Response) => {
  const { id, ticketId } = params<TicketParams>(req);
  ok(res, await restaurantService.kitchenTicket(getContext(req), id, ticketId));
});

export const receipt = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantService.receipt(getContext(req), params<IdParams>(req).id));
});

export const dashboard = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantService.dashboard(getContext(req), query<DashboardInput>(req)));
});

/**
 * A refund against a paid order. The money goes back on a tender the branch
 * takes; nothing goes back on a shelf, because a restaurant keeps no stock.
 */
export const createOrderReturn = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<CreateOrderReturnInput>(req);
  const result = await posReturnService.create(ctx, restaurantSaleReturnAdapter, {
    saleId: id,
    reason: input.reason,
    refundMethod: input.refundMethod,
    // Nothing to restock, so every line is recorded as not restocked.
    items: input.items.map((line) => ({ ...line, restock: false })),
  });
  await recordAudit(req, {
    action: 'restaurant.order_refunded',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: result.returnNumber,
    newValue: { orderNumber: result.saleNumberSnapshot, totalMinor: result.totalMinor, reason: result.reason },
  });
  created(res, result);
});

export const listOrderReturns = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await listPosReturns(ctx, 'restaurant', query<{ page?: number; limit?: number; search?: string }>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

// --------------------------------------------------------------- shifts
export const currentShift = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await shiftService.current(getContext(req)));
});

export const openShift = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await shiftService.open(ctx, body<OpenShiftInput>(req));
  await recordAudit(req, {
    action: 'restaurant.shift.opened',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: result.shift.shiftNumber,
    newValue: { openingFloatMinor: result.shift.openingFloatMinor },
  });
  created(res, result);
});

export const addCashMovement = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<CashMovementInput>(req);
  const result = await shiftService.addCashMovement(ctx, params<IdParams>(req).id, input);
  await recordAudit(req, {
    action: `restaurant.shift.${input.type}`,
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: result.shift.shiftNumber,
    newValue: { amountMinor: input.amountMinor, reason: input.reason },
  });
  ok(res, result);
});

export const closeShift = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await shiftService.close(ctx, params<IdParams>(req).id, body<CloseShiftInput>(req));
  await recordAudit(req, {
    action: 'restaurant.shift.closed',
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

export const listShifts = asyncHandler(async (req: Request, res: Response) => {
  const result = await shiftService.list(getContext(req), query<ListShiftsInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getShift = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await shiftService.get(getContext(req), params<IdParams>(req).id));
});

export const reports = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantReportsService.report(getContext(req), query<DashboardInput>(req)));
});

/** The same report as a PDF: what the screen shows, printed. */
export const printReports = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const data = await restaurantReportsService.report(ctx, query<DashboardInput>(req));
  await streamReportPdf(ctx, res, restaurantReportView(data as unknown as Record<string, unknown>, await storeCurrency(ctx)));
});

export const summary = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await restaurantService.summary(getContext(req), query<SummaryInput>(req)));
});
