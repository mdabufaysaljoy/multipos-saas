import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/apiResponse';
import { query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { reportService } from './reports.service';
import { entitlementService } from '../../services/subscription/entitlement.service';
import type { BreakdownInput, InventoryReportInput, ReportRangeInput } from './reports.validators';

export const dashboard = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reportService.dashboard(getContext(req), query<ReportRangeInput>(req)));
});

export const overview = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const [report, entitlement] = await Promise.all([
    reportService.overview(ctx, query<ReportRangeInput>(req)),
    entitlementService.forTenant(ctx.tenantId),
  ]);
  // The Dashboard is on every plan, but profit is Advanced Analytics. Removing it
  // here, not in the browser, keeps it out of the response entirely.
  if (!entitlement.features.advancedReports) {
    ok(res, { ...report, kpis: { ...report.kpis, profitMinor: null } });
    return;
  }
  ok(res, report);
});

export const salesAndProfit = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reportService.salesAnalytics(getContext(req), query<ReportRangeInput>(req)));
});

export const breakdown = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reportService.breakdown(getContext(req), query<BreakdownInput>(req)));
});

export const payments = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reportService.paymentReport(getContext(req), query<ReportRangeInput>(req)));
});

export const returns = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reportService.returnReport(getContext(req), query<ReportRangeInput>(req)));
});

export const staff = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reportService.staffReport(getContext(req), query<ReportRangeInput>(req)));
});

export const customers = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reportService.customerReport(getContext(req), query<ReportRangeInput>(req)));
});

export const inventory = asyncHandler(async (req: Request, res: Response) => {
  const input = query<InventoryReportInput>(req);
  ok(res, await reportService.inventoryReport(getContext(req), input.limit, input.branch));
});

export const branches = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await reportService.branchReport(getContext(req), query<ReportRangeInput>(req)));
});
