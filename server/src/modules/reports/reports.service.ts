import { Types } from 'mongoose';
import dayjs from 'dayjs';
import { SALE_STATUS } from '../../config/constants';
import { ReturnModel } from '../../models/Return';
import { SaleModel } from '../../models/Sale';
import type { TenantContext } from '../../types/express';
import { ProductVariantModel } from '../../models/ProductVariant';
import { StoreModel } from '../../models/Store';
import { ApiError } from '../../utils/ApiError';
import { tenderLabels } from '../../services/pos/paymentMethods.service';
import type { BreakdownInput, DashboardRangeInput, ReportRangeInput } from './reports.validators';

export interface ResolvedRange {
  from: Date;
  to: Date;
  label: string;
}

/**
 * Turns a preset into concrete boundaries. Custom ranges are honoured as given,
 * which is what makes multi-year reporting (e.g. 2025-01-01 -> 2026-08-25) work
 * with no special casing.
 */
export function resolveRange(input: ReportRangeInput): ResolvedRange {
  const now = dayjs();
  switch (input.preset) {
    case 'today':
      return { from: now.startOf('day').toDate(), to: now.endOf('day').toDate(), label: 'Today' };
    case 'yesterday': {
      const y = now.subtract(1, 'day');
      return { from: y.startOf('day').toDate(), to: y.endOf('day').toDate(), label: 'Yesterday' };
    }
    case 'last7':
      return { from: now.subtract(6, 'day').startOf('day').toDate(), to: now.endOf('day').toDate(), label: 'Last 7 days' };
    case 'last30':
      return { from: now.subtract(29, 'day').startOf('day').toDate(), to: now.endOf('day').toDate(), label: 'Last 30 days' };
    case 'thisMonth':
      return { from: now.startOf('month').toDate(), to: now.endOf('day').toDate(), label: 'This month' };
    case 'lastMonth': {
      const m = now.subtract(1, 'month');
      return { from: m.startOf('month').toDate(), to: m.endOf('month').toDate(), label: 'Last month' };
    }
    case 'thisYear':
      return { from: now.startOf('year').toDate(), to: now.endOf('day').toDate(), label: 'This year' };
    case 'custom':
    default:
      return {
        from: dayjs(input.from ?? now.subtract(6, 'day')).startOf('day').toDate(),
        to: dayjs(input.to ?? now).endOf('day').toDate(),
        label: 'Custom range',
      };
  }
}

/**
 * The clock every report groups by.
 *
 * `resolveRange` computes its boundaries with dayjs, which uses the server's
 * timezone, so anything that buckets sales into days has to use the same one.
 * Grouping in UTC while the range ends at local midnight puts a late-evening
 * sale in tomorrow's bucket - or drops it from "today" altogether.
 */
export function reportTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A dashboard's range, the period before it, and how to bucket the trend. */
export interface DashboardWindow extends ResolvedRange {
  preset: DashboardRangeInput['preset'];
  /** Fine enough to be useful, coarse enough to stay readable. */
  bucket: 'hour' | 'day' | 'month';
  /** The `$dateToString` format for `bucket`. */
  format: string;
  timezone: string;
  days: number;
  previousFrom: Date;
  previousTo: Date;
}

/**
 * Everything a vertical dashboard needs from its date range, resolved once.
 *
 * The comparison period is the span of equal length ending the instant the
 * range begins, so "last 7 days" is always measured against the 7 days before
 * it, whatever the preset. Shared by all four POS types so that the same
 * preset means the same dates in every one of them.
 */
export function resolveDashboardWindow(input: DashboardRangeInput): DashboardWindow {
  const range = resolveRange({ ...input, granularity: 'day', branch: 'current', limit: 10 } as ReportRangeInput);
  const days = Math.max(1, dayjs(range.to).startOf('day').diff(dayjs(range.from).startOf('day'), 'day') + 1);
  const bucket = days <= 1 ? 'hour' : days <= 62 ? 'day' : 'month';

  return {
    ...range,
    preset: input.preset,
    bucket,
    format: { hour: '%H:00', day: '%Y-%m-%d', month: '%Y-%m' }[bucket],
    timezone: reportTimezone(),
    days,
    previousFrom: dayjs(range.from).subtract(days, 'day').toDate(),
    previousTo: dayjs(range.from).subtract(1, 'millisecond').toDate(),
  };
}

const DATE_FORMAT: Record<string, string> = { day: '%Y-%m-%d', week: '%G-W%V', month: '%Y-%m' };

/**
 * Every figure here is produced by a MongoDB aggregation. Sales are never
 * shipped to the browser to be summed client-side, so the dashboard stays fast
 * across years of history.
 */
class ReportService {
  /**
   * Turns the requested branch scope into a `storeId` filter fragment.
   *
   * "all" aggregates across every branch and is admin-only: a branch manager
   * asking for it silently gets their own branch rather than an error, so a
   * shared dashboard link cannot leak another branch's numbers.
   */
  private storeScope(ctx: TenantContext, branch: ReportRangeInput['branch']): Record<string, unknown> {
    if (branch === 'all') {
      return ctx.isAdmin ? {} : { storeId: ctx.storeId };
    }
    if (branch === 'current' || !branch) return { storeId: ctx.storeId };

    // A specific branch: admins may pick any of their own; others may not.
    if (!ctx.isAdmin) return { storeId: ctx.storeId };
    return { storeId: branch };
  }

  private saleMatch(ctx: TenantContext, range: ResolvedRange, input: ReportRangeInput) {
    const match: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      ...this.storeScope(ctx, input.branch),
      status: SALE_STATUS.COMPLETED,
      soldAt: { $gte: range.from, $lte: range.to },
    };
    if (input.cashierId) match.cashierId = input.cashierId;
    return match;
  }

  /**
   * Per-branch comparison: sales, profit and returns for each branch the tenant
   * owns. This is the aggregated view a multi-branch owner actually wants.
   */
  async branchReport(ctx: TenantContext, input: ReportRangeInput) {
    if (!ctx.isAdmin) throw ApiError.forbidden('Only a workspace administrator can compare branches');

    const range = resolveRange(input);
    const stores = await StoreModel.find({ tenantId: ctx.tenantId, deletedAt: null }).select('name code isActive').lean();

    const [sales, returns, stock] = await Promise.all([
      SaleModel.aggregate<{ _id: Types.ObjectId; revenueMinor: number; orders: number; items: number; cogsMinor: number }>([
        { $match: { tenantId: ctx.tenantId, status: SALE_STATUS.COMPLETED, soldAt: { $gte: range.from, $lte: range.to } } },
        {
          $group: {
            _id: '$storeId',
            revenueMinor: { $sum: '$totalMinor' },
            orders: { $sum: 1 },
            items: { $sum: { $sum: '$items.quantity' } },
            cogsMinor: {
              $sum: {
                $reduce: {
                  input: '$items',
                  initialValue: 0,
                  in: { $add: ['$$value', { $multiply: ['$$this.costPriceMinorSnapshot', '$$this.quantity'] }] },
                },
              },
            },
          },
        },
      ]),
      ReturnModel.aggregate<{ _id: Types.ObjectId; amountMinor: number; count: number; cogsMinor: number }>([
        { $match: { tenantId: ctx.tenantId, returnedAt: { $gte: range.from, $lte: range.to } } },
        {
          $group: {
            _id: '$storeId',
            amountMinor: { $sum: '$totalMinor' },
            count: { $sum: 1 },
            cogsMinor: {
              $sum: {
                $reduce: {
                  input: '$items',
                  initialValue: 0,
                  in: { $add: ['$$value', { $multiply: [{ $ifNull: ['$$this.costPriceMinorSnapshot', 0] }, '$$this.quantity'] }] },
                },
              },
            },
          },
        },
      ]),
      ProductVariantModel.aggregate<{ _id: Types.ObjectId; units: number; valueMinor: number }>([
        { $match: { tenantId: ctx.tenantId, deletedAt: null } },
        { $group: { _id: '$storeId', units: { $sum: { $max: ['$stock', 0] } }, valueMinor: { $sum: { $multiply: [{ $max: ['$stock', 0] }, '$costPriceMinor'] } } } },
      ]),
    ]);

    const byId = <T extends { _id: Types.ObjectId }>(rows: T[]) => new Map(rows.map((r) => [String(r._id), r]));
    const saleBy = byId(sales);
    const returnBy = byId(returns);
    const stockBy = byId(stock);

    const rows = stores.map((store) => {
      const key = String(store._id);
      const sale = saleBy.get(key);
      const ret = returnBy.get(key);
      const st = stockBy.get(key);

      const revenueMinor = sale?.revenueMinor ?? 0;
      const returnAmountMinor = ret?.amountMinor ?? 0;
      const cogsMinor = (sale?.cogsMinor ?? 0) - (ret?.cogsMinor ?? 0);
      const netSalesMinor = revenueMinor - returnAmountMinor;

      return {
        id: store._id,
        name: store.name,
        code: store.code,
        isActive: store.isActive,
        orders: sale?.orders ?? 0,
        items: sale?.items ?? 0,
        revenueMinor,
        returnCount: ret?.count ?? 0,
        returnAmountMinor,
        netSalesMinor,
        profitMinor: netSalesMinor - cogsMinor,
        stockUnits: st?.units ?? 0,
        stockValueMinor: st?.valueMinor ?? 0,
      };
    });

    const totals = rows.reduce(
      (acc, row) => ({
        orders: acc.orders + row.orders,
        netSalesMinor: acc.netSalesMinor + row.netSalesMinor,
        profitMinor: acc.profitMinor + row.profitMinor,
        returnAmountMinor: acc.returnAmountMinor + row.returnAmountMinor,
        stockValueMinor: acc.stockValueMinor + row.stockValueMinor,
      }),
      { orders: 0, netSalesMinor: 0, profitMinor: 0, returnAmountMinor: 0, stockValueMinor: 0 },
    );

    return { range: { from: range.from, to: range.to, label: range.label }, rows, totals };
  }

  /**
   * The dashboard is a QUICK OVERVIEW, not a report: a handful of KPIs, a
   * trend, the current stock position and the latest sales. Detailed analysis
   * lives in the reports endpoints, so the two screens no longer duplicate
   * each other.
   */
  async overview(ctx: TenantContext, input: ReportRangeInput) {
    const [figures, stock, recentSales, lowStock, payments] = await Promise.all([
      this.salesAndProfit(ctx, input),
      this.inventoryReport(ctx, 5),
      SaleModel.find({ tenantId: ctx.tenantId, storeId: ctx.storeId, status: SALE_STATUS.COMPLETED })
        .sort({ soldAt: -1 })
        .limit(6)
        .select('saleNumber soldAt totalMinor paymentMethod cashierNameSnapshot customerSnapshot items')
        .lean(),
      this.inventoryReport(ctx, 5),
      this.paymentReport(ctx, input),
    ]);

    const range = resolveRange(input);
    const trend = await this.trend(this.saleMatch(ctx, range, input), input.granularity);
    const topProducts = await this.topProducts(this.saleMatch(ctx, range, input), 5);

    return {
      range: figures.range,
      kpis: {
        salesMinor: figures.netSalesMinor,
        grossSalesMinor: figures.grossSalesMinor,
        orderCount: figures.invoiceCount,
        itemCount: figures.itemCount,
        profitMinor: figures.netProfitMinor,
        returnCount: figures.returnCount,
        returnAmountMinor: figures.returnAmountMinor,
        averageOrderValueMinor: figures.averageOrderValueMinor,
        stockValueMinor: stock.summary.costValueMinor,
        stockUnits: stock.summary.units,
        lowStockCount: stock.summary.lowStockCount,
        outOfStockCount: stock.summary.outOfStockCount,
      },
      trend,
      topProducts,
      lowStock: lowStock.lowStock,
      recentSales: recentSales.map((sale) => ({
        id: sale._id,
        saleNumber: sale.saleNumber,
        soldAt: sale.soldAt,
        totalMinor: sale.totalMinor,
        paymentMethod: sale.paymentMethod,
        cashier: sale.cashierNameSnapshot,
        customer: sale.customerSnapshot?.name ?? null,
        itemCount: sale.items.reduce((sum, item) => sum + item.quantity, 0),
      })),
      payments: payments.rows,
    };
  }

  async dashboard(ctx: TenantContext, input: ReportRangeInput) {
    const range = resolveRange(input);
    const match = this.saleMatch(ctx, range, input);

    const [summary, returns, trend, topProducts, topVariants, byCategory, byPaymentMethod, byStaff] = await Promise.all([
      this.summary(match),
      this.returnSummary(ctx, range, input.branch),
      this.trend(match, input.granularity),
      this.topProducts(match, input.limit),
      this.topVariants(match, input.limit),
      this.salesByCategory(match),
      this.salesByPaymentMethod(match),
      this.salesByStaff(match),
    ]);

    const grossSalesMinor = summary.totalSalesMinor;
    const netSalesMinor = grossSalesMinor - returns.totalMinor;

    return {
      range: { from: range.from, to: range.to, label: range.label, preset: input.preset },
      summary: {
        ...summary,
        returnCount: returns.count,
        returnedItems: returns.items,
        returnAmountMinor: returns.totalMinor,
        netSalesMinor,
        averageOrderValueMinor: summary.orderCount > 0 ? Math.round(grossSalesMinor / summary.orderCount) : 0,
        grossProfitMinor: summary.totalCostMinor > 0 ? netSalesMinor - summary.totalCostMinor : 0,
      },
      trend,
      topProducts,
      topVariants,
      byCategory,
      byPaymentMethod,
      byStaff,
    };
  }


  // ======================================================================
  //  Reports (detailed analysis) - distinct from the dashboard's overview
  // ======================================================================

  /**
   * Sales + profit for a period.
   *
   * Profit uses ONLY the snapshots captured on the sale line
   * (`unitPriceMinor`, `costPriceMinorSnapshot`), never the product's current
   * price or cost. Editing or deleting a product therefore cannot retroactively
   * change a historical profit figure.
   *
   *   Gross sales   = sum(line totals)          - before order-level discount
   *   Discounts     = sum(sale.discountMinor)
   *   Returns       = sum(return.totalMinor)    - by RETURN date
   *   COGS          = sum(cost x qty sold) - sum(cost x qty returned)
   *   Net sales     = gross - discounts - returns
   *   Net profit    = net sales - COGS
   */
  async salesAndProfit(ctx: TenantContext, input: ReportRangeInput) {
    const range = resolveRange(input);
    const match = this.saleMatch(ctx, range, input);

    const [saleRow] = await SaleModel.aggregate<{
      grossSalesMinor: number;
      discountsMinor: number;
      taxMinor: number;
      cogsMinor: number;
      invoiceCount: number;
      itemCount: number;
      netTotalMinor: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: null,
          grossSalesMinor: { $sum: { $sum: '$items.lineTotalMinor' } },
          discountsMinor: { $sum: '$discountMinor' },
          taxMinor: { $sum: '$taxMinor' },
          netTotalMinor: { $sum: '$totalMinor' },
          invoiceCount: { $sum: 1 },
          itemCount: { $sum: { $sum: '$items.quantity' } },
          cogsMinor: {
            $sum: {
              $reduce: {
                input: '$items',
                initialValue: 0,
                in: { $add: ['$$value', { $multiply: ['$$this.costPriceMinorSnapshot', '$$this.quantity'] }] },
              },
            },
          },
        },
      },
    ]);

    const [returnRow] = await ReturnModel.aggregate<{
      returnAmountMinor: number;
      returnCount: number;
      returnedItems: number;
      returnedCogsMinor: number;
    }>([
      { $match: { tenantId: ctx.tenantId, ...this.storeScope(ctx, input.branch), returnedAt: { $gte: range.from, $lte: range.to } } },
      {
        $group: {
          _id: null,
          returnAmountMinor: { $sum: '$totalMinor' },
          returnCount: { $sum: 1 },
          returnedItems: { $sum: { $sum: '$items.quantity' } },
          returnedCogsMinor: {
            $sum: {
              $reduce: {
                input: '$items',
                initialValue: 0,
                in: {
                  $add: [
                    '$$value',
                    { $multiply: [{ $ifNull: ['$$this.costPriceMinorSnapshot', 0] }, '$$this.quantity'] },
                  ],
                },
              },
            },
          },
        },
      },
    ]);

    const grossSalesMinor = saleRow?.grossSalesMinor ?? 0;
    const discountsMinor = saleRow?.discountsMinor ?? 0;
    const returnAmountMinor = returnRow?.returnAmountMinor ?? 0;
    // Returned goods take their cost back out of COGS.
    const cogsMinor = (saleRow?.cogsMinor ?? 0) - (returnRow?.returnedCogsMinor ?? 0);

    const netSalesMinor = grossSalesMinor - discountsMinor - returnAmountMinor;
    const netProfitMinor = netSalesMinor - cogsMinor;
    const invoiceCount = saleRow?.invoiceCount ?? 0;

    return {
      range: { from: range.from, to: range.to, label: range.label, preset: input.preset },
      grossSalesMinor,
      discountsMinor,
      returnAmountMinor,
      taxMinor: saleRow?.taxMinor ?? 0,
      cogsMinor,
      netSalesMinor,
      netProfitMinor,
      /** Basis points, so the margin stays an integer. */
      marginBasisPoints: netSalesMinor > 0 ? Math.round((netProfitMinor / netSalesMinor) * 10_000) : 0,
      invoiceCount,
      itemCount: saleRow?.itemCount ?? 0,
      returnCount: returnRow?.returnCount ?? 0,
      returnedItems: returnRow?.returnedItems ?? 0,
      averageOrderValueMinor: invoiceCount > 0 ? Math.round((saleRow?.netTotalMinor ?? 0) / invoiceCount) : 0,
    };
  }

  /**
   * Sales & profit for the period, plus the sales trend and the same figures
   * for the immediately preceding period of equal length (last 30 days vs the
   * 30 days before). Powers the Advanced Analytics sales tab.
   */
  async salesAnalytics(ctx: TenantContext, input: ReportRangeInput) {
    const range = resolveRange(input);
    const days = Math.max(1, dayjs(range.to).startOf('day').diff(dayjs(range.from).startOf('day'), 'day') + 1);
    const previousTo = dayjs(range.from).subtract(1, 'day');
    const previousFrom = previousTo.subtract(days - 1, 'day');

    const [current, previous, trend] = await Promise.all([
      this.salesAndProfit(ctx, input),
      this.salesAndProfit(ctx, { ...input, preset: 'custom', from: previousFrom.toDate(), to: previousTo.toDate() }),
      this.trend(this.saleMatch(ctx, range, input), input.granularity),
    ]);

    return {
      ...current,
      trend,
      previous: {
        range: { from: previous.range.from, to: previous.range.to },
        grossSalesMinor: previous.grossSalesMinor,
        discountsMinor: previous.discountsMinor,
        returnAmountMinor: previous.returnAmountMinor,
        netSalesMinor: previous.netSalesMinor,
        cogsMinor: previous.cogsMinor,
        netProfitMinor: previous.netProfitMinor,
        marginBasisPoints: previous.marginBasisPoints,
        invoiceCount: previous.invoiceCount,
        itemCount: previous.itemCount,
        averageOrderValueMinor: previous.averageOrderValueMinor,
      },
    };
  }

  /**
   * One aggregation shape serving every breakdown dimension.
   *
   * Product, variant, category and staff all reduce to "group the sale lines by
   * some snapshot field, then sum quantity / revenue / profit". Keeping them in
   * one pipeline avoids five near-identical endpoints drifting apart.
   */
  async breakdown(ctx: TenantContext, input: BreakdownInput) {
    const range = resolveRange(input);
    const match = this.saleMatch(ctx, range, input);

    const GROUPING: Record<string, { id: string; label: string; extra?: Record<string, unknown> }> = {
      product: { id: '$items.productId', label: '$items.productNameSnapshot' },
      variant: { id: '$items.variantId', label: '$items.variantNameSnapshot', extra: { sub: { $first: '$items.productNameSnapshot' }, sku: { $first: '$items.skuSnapshot' } } },
      category: { id: '$items.categoryId', label: '$items.categoryNameSnapshot' },
      brand: { id: '$items.brandSnapshot', label: '$items.brandSnapshot' },
    };

    const grouping = GROUPING[input.dimension];
    if (!grouping) throw ApiError.badRequest(`Unsupported report dimension "${input.dimension}"`);

    const SORTS: Record<string, string> = {
      quantity: 'quantity',
      revenue: 'revenueMinor',
      profit: 'profitMinor',
    };
    const sortField = SORTS[input.sortBy] ?? 'quantity';
    const direction = input.order === 'asc' ? 1 : -1;

    const rows = await SaleModel.aggregate([
      { $match: match },
      { $unwind: '$items' },
      ...(input.categoryId ? [{ $match: { 'items.categoryId': input.categoryId } }] : []),
      {
        $group: {
          _id: grouping.id,
          label: { $first: grouping.label },
          ...(grouping.extra ?? {}),
          // Net of returns: a refunded unit stops counting as sold.
          quantity: { $sum: { $subtract: ['$items.quantity', { $ifNull: ['$items.returnedQuantity', 0] }] } },
          grossQuantity: { $sum: '$items.quantity' },
          returnedQuantity: { $sum: { $ifNull: ['$items.returnedQuantity', 0] } },
          revenueMinor: {
            $sum: {
              $multiply: [
                '$items.unitPriceMinor',
                { $subtract: ['$items.quantity', { $ifNull: ['$items.returnedQuantity', 0] }] },
              ],
            },
          },
          costMinor: {
            $sum: {
              $multiply: [
                '$items.costPriceMinorSnapshot',
                { $subtract: ['$items.quantity', { $ifNull: ['$items.returnedQuantity', 0] }] },
              ],
            },
          },
        },
      },
      { $addFields: { profitMinor: { $subtract: ['$revenueMinor', '$costMinor'] } } },
      { $sort: { [sortField]: direction, label: 1 } },
      { $limit: input.limit },
      {
        $project: {
          _id: 0,
          id: '$_id',
          label: 1,
          sub: 1,
          sku: 1,
          quantity: 1,
          grossQuantity: 1,
          returnedQuantity: 1,
          revenueMinor: 1,
          costMinor: 1,
          profitMinor: 1,
        },
      },
    ]);

    return { range: { from: range.from, to: range.to, label: range.label }, dimension: input.dimension, rows };
  }

  /** Sales grouped by tender, including the split-payment breakdown. */
  async paymentReport(ctx: TenantContext, input: ReportRangeInput) {
    const range = resolveRange(input);
    const match = this.saleMatch(ctx, range, input);

    // Unwinding `payments` counts each tender of a split sale separately, which
    // is what a cash-drawer reconciliation actually needs.
    const rows = await SaleModel.aggregate<{ method: string; amountMinor: number; count: number }>([
      { $match: match },
      { $unwind: { path: '$payments', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { $ifNull: ['$payments.method', '$paymentMethod'] },
          amountMinor: { $sum: { $ifNull: ['$payments.amountMinor', '$totalMinor'] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { amountMinor: -1 } },
      { $project: { _id: 0, method: '$_id', amountMinor: 1, count: 1 } },
    ]);

    // Grouped by the key the sale recorded; named with what the workspace calls
    // it today. A key it no longer has keeps its own name rather than vanishing.
    const names = await tenderLabels(ctx.tenantId);
    return {
      range: { from: range.from, to: range.to, label: range.label },
      rows: rows.map((row) => ({ ...row, methodLabel: names.get(row.method) ?? row.method })),
    };
  }

  /** Returns analysis: what came back, how much and why. */
  async returnReport(ctx: TenantContext, input: ReportRangeInput) {
    const range = resolveRange(input);
    const match = {
      tenantId: ctx.tenantId,
      ...this.storeScope(ctx, input.branch),
      returnedAt: { $gte: range.from, $lte: range.to },
    };

    const [byProduct, byReason, [totals]] = await Promise.all([
      ReturnModel.aggregate([
        { $match: match },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.variantId',
            label: { $first: '$items.productNameSnapshot' },
            sub: { $first: '$items.variantNameSnapshot' },
            sku: { $first: '$items.skuSnapshot' },
            quantity: { $sum: '$items.quantity' },
            amountMinor: { $sum: '$items.lineTotalMinor' },
          },
        },
        { $sort: { quantity: -1 } },
        { $limit: input.limit },
        { $project: { _id: 0, id: '$_id', label: 1, sub: 1, sku: 1, quantity: 1, amountMinor: 1 } },
      ]),
      ReturnModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $cond: [{ $eq: [{ $ifNull: ['$reason', ''] }, ''] }, 'Not given', '$reason'] },
            count: { $sum: 1 },
            amountMinor: { $sum: '$totalMinor' },
          },
        },
        { $sort: { count: -1 } },
        { $project: { _id: 0, reason: '$_id', count: 1, amountMinor: 1 } },
      ]),
      ReturnModel.aggregate<{ count: number; amountMinor: number; items: number }>([
        { $match: match },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            amountMinor: { $sum: '$totalMinor' },
            items: { $sum: { $sum: '$items.quantity' } },
          },
        },
      ]),
    ]);

    return {
      range: { from: range.from, to: range.to, label: range.label },
      summary: { count: totals?.count ?? 0, amountMinor: totals?.amountMinor ?? 0, items: totals?.items ?? 0 },
      byProduct,
      byReason,
    };
  }

  /** Stock position: value, low stock and out of stock. Not time-ranged. */
  async inventoryReport(ctx: TenantContext, limit: number, branch: ReportRangeInput['branch'] = 'current') {
    const base = { tenantId: ctx.tenantId, ...this.storeScope(ctx, branch), deletedAt: null };

    const [[totals], lowStock, outOfStock, topValue] = await Promise.all([
      ProductVariantModel.aggregate<{ units: number; costValueMinor: number; retailValueMinor: number; variants: number }>([
        { $match: base },
        {
          $group: {
            _id: null,
            // Stock below zero (an out-of-stock sale) holds no value.
            units: { $sum: { $max: ['$stock', 0] } },
            costValueMinor: { $sum: { $multiply: [{ $max: ['$stock', 0] }, '$costPriceMinor'] } },
            retailValueMinor: { $sum: { $multiply: [{ $max: ['$stock', 0] }, '$sellingPriceMinor'] } },
            variants: { $sum: 1 },
          },
        },
      ]),
      ProductVariantModel.find({
        ...base,
        $expr: { $and: [{ $gt: ['$lowStockThreshold', 0] }, { $lte: ['$stock', '$lowStockThreshold'] }, { $gt: ['$stock', 0] }] },
      })
        .sort({ stock: 1 })
        .limit(limit)
        .select('productNameSnapshot name sku stock lowStockThreshold sellingPriceMinor')
        .lean(),
      ProductVariantModel.find({ ...base, stock: { $lte: 0 } })
        .limit(limit)
        .select('productNameSnapshot name sku stock sellingPriceMinor')
        .lean(),
      ProductVariantModel.aggregate([
        { $match: base },
        { $addFields: { valueMinor: { $multiply: [{ $max: ['$stock', 0] }, '$costPriceMinor'] } } },
        { $sort: { valueMinor: -1 } },
        { $limit: limit },
        { $project: { _id: 1, productNameSnapshot: 1, name: 1, sku: 1, stock: 1, valueMinor: 1 } },
      ]),
    ]);

    return {
      summary: {
        units: totals?.units ?? 0,
        costValueMinor: totals?.costValueMinor ?? 0,
        retailValueMinor: totals?.retailValueMinor ?? 0,
        variants: totals?.variants ?? 0,
        lowStockCount: lowStock.length,
        outOfStockCount: outOfStock.length,
      },
      lowStock,
      outOfStock,
      topValue,
    };
  }

  /** Top customers by spend in the period. */
  async customerReport(ctx: TenantContext, input: ReportRangeInput) {
    const range = resolveRange(input);
    const match = this.saleMatch(ctx, range, input);

    const rows = await SaleModel.aggregate([
      { $match: { ...match, customerId: { $ne: null } } },
      {
        $group: {
          _id: '$customerId',
          label: { $first: '$customerSnapshot.name' },
          sub: { $first: '$customerSnapshot.phone' },
          orderCount: { $sum: 1 },
          spentMinor: { $sum: '$totalMinor' },
          itemCount: { $sum: { $sum: '$items.quantity' } },
        },
      },
      { $sort: { spentMinor: -1 } },
      { $limit: input.limit },
      { $project: { _id: 0, id: '$_id', label: 1, sub: 1, orderCount: 1, spentMinor: 1, itemCount: 1 } },
    ]);

    const [[walkIn], [summary]] = await Promise.all([
      SaleModel.aggregate<{ count: number; totalMinor: number }>([
        { $match: { ...match, customerId: null } },
        { $group: { _id: null, count: { $sum: 1 }, totalMinor: { $sum: '$totalMinor' } } },
      ]),
      // Every buying customer in the period, not just the top N above.
      SaleModel.aggregate<{ customers: number; repeatCustomers: number; totalMinor: number; orders: number }>([
        { $match: { ...match, customerId: { $ne: null } } },
        { $group: { _id: '$customerId', orders: { $sum: 1 }, spentMinor: { $sum: '$totalMinor' } } },
        {
          $group: {
            _id: null,
            customers: { $sum: 1 },
            repeatCustomers: { $sum: { $cond: [{ $gte: ['$orders', 2] }, 1, 0] } },
            totalMinor: { $sum: '$spentMinor' },
            orders: { $sum: '$orders' },
          },
        },
      ]),
    ]);

    const customers = summary?.customers ?? 0;
    return {
      range: { from: range.from, to: range.to, label: range.label },
      rows,
      walkIn: { count: walkIn?.count ?? 0, totalMinor: walkIn?.totalMinor ?? 0 },
      summary: {
        customers,
        repeatCustomers: summary?.repeatCustomers ?? 0,
        orders: summary?.orders ?? 0,
        totalMinor: summary?.totalMinor ?? 0,
        averageSpendMinor: customers > 0 ? Math.round((summary?.totalMinor ?? 0) / customers) : 0,
      },
    };
  }

  /** Staff performance, including profit generated. */
  async staffReport(ctx: TenantContext, input: ReportRangeInput) {
    const range = resolveRange(input);
    const match = this.saleMatch(ctx, range, input);

    const rows = await SaleModel.aggregate([
      { $match: match },
      {
        $addFields: {
          lineProfit: {
            $reduce: {
              input: '$items',
              initialValue: 0,
              in: {
                $add: [
                  '$$value',
                  {
                    $multiply: [
                      { $subtract: ['$$this.unitPriceMinor', '$$this.costPriceMinorSnapshot'] },
                      { $subtract: ['$$this.quantity', { $ifNull: ['$$this.returnedQuantity', 0] }] },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
      {
        $group: {
          _id: '$cashierId',
          label: { $first: '$cashierNameSnapshot' },
          orderCount: { $sum: 1 },
          revenueMinor: { $sum: '$totalMinor' },
          itemCount: { $sum: { $sum: '$items.quantity' } },
          profitMinor: { $sum: '$lineProfit' },
        },
      },
      { $sort: { revenueMinor: -1 } },
      { $project: { _id: 0, id: '$_id', label: 1, orderCount: 1, revenueMinor: 1, itemCount: 1, profitMinor: 1 } },
    ]);

    return { range: { from: range.from, to: range.to, label: range.label }, rows };
  }

  private async summary(match: Record<string, unknown>) {
    const [row] = await SaleModel.aggregate<{
      totalSalesMinor: number;
      orderCount: number;
      itemCount: number;
      discountMinor: number;
      taxMinor: number;
      totalCostMinor: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: null,
          totalSalesMinor: { $sum: '$totalMinor' },
          orderCount: { $sum: 1 },
          itemCount: { $sum: { $sum: '$items.quantity' } },
          discountMinor: { $sum: '$discountMinor' },
          taxMinor: { $sum: '$taxMinor' },
          totalCostMinor: {
            $sum: {
              $reduce: {
                input: '$items',
                initialValue: 0,
                in: { $add: ['$$value', { $multiply: ['$$this.costPriceMinorSnapshot', '$$this.quantity'] }] },
              },
            },
          },
        },
      },
    ]);

    return {
      totalSalesMinor: row?.totalSalesMinor ?? 0,
      orderCount: row?.orderCount ?? 0,
      itemCount: row?.itemCount ?? 0,
      discountMinor: row?.discountMinor ?? 0,
      taxMinor: row?.taxMinor ?? 0,
      totalCostMinor: row?.totalCostMinor ?? 0,
    };
  }

  private async returnSummary(ctx: TenantContext, range: ResolvedRange, branch: ReportRangeInput['branch'] = 'current') {
    const [row] = await ReturnModel.aggregate<{ totalMinor: number; count: number; items: number }>([
      {
        $match: {
          tenantId: ctx.tenantId,
          ...this.storeScope(ctx, branch),
          returnedAt: { $gte: range.from, $lte: range.to },
        },
      },
      {
        $group: {
          _id: null,
          totalMinor: { $sum: '$totalMinor' },
          count: { $sum: 1 },
          items: { $sum: { $sum: '$items.quantity' } },
        },
      },
    ]);
    return { totalMinor: row?.totalMinor ?? 0, count: row?.count ?? 0, items: row?.items ?? 0 };
  }

  private async trend(match: Record<string, unknown>, granularity: string) {
    return SaleModel.aggregate<{ bucket: string; totalMinor: number; orderCount: number; itemCount: number }>([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: DATE_FORMAT[granularity] ?? DATE_FORMAT.day, date: '$soldAt', timezone: reportTimezone() } },
          totalMinor: { $sum: '$totalMinor' },
          orderCount: { $sum: 1 },
          itemCount: { $sum: { $sum: '$items.quantity' } },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, bucket: '$_id', totalMinor: 1, orderCount: 1, itemCount: 1 } },
    ]);
  }

  /** Grouped on the SNAPSHOT name, so deleted products still appear correctly. */
  private async topProducts(match: Record<string, unknown>, limit: number) {
    return SaleModel.aggregate<{ productId: Types.ObjectId; name: string; quantity: number; revenueMinor: number }>([
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.productId',
          name: { $first: '$items.productNameSnapshot' },
          quantity: { $sum: '$items.quantity' },
          revenueMinor: { $sum: '$items.lineTotalMinor' },
        },
      },
      { $sort: { quantity: -1, revenueMinor: -1 } },
      { $limit: limit },
      { $project: { _id: 0, productId: '$_id', name: 1, quantity: 1, revenueMinor: 1 } },
    ]);
  }

  private async topVariants(match: Record<string, unknown>, limit: number) {
    return SaleModel.aggregate<{
      variantId: Types.ObjectId;
      productName: string;
      variantName: string;
      sku: string;
      quantity: number;
      revenueMinor: number;
    }>([
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.variantId',
          productName: { $first: '$items.productNameSnapshot' },
          variantName: { $first: '$items.variantNameSnapshot' },
          sku: { $first: '$items.skuSnapshot' },
          quantity: { $sum: '$items.quantity' },
          revenueMinor: { $sum: '$items.lineTotalMinor' },
        },
      },
      { $sort: { quantity: -1, revenueMinor: -1 } },
      { $limit: limit },
      { $project: { _id: 0, variantId: '$_id', productName: 1, variantName: 1, sku: 1, quantity: 1, revenueMinor: 1 } },
    ]);
  }

  private async salesByCategory(match: Record<string, unknown>) {
    return SaleModel.aggregate<{ categoryId: Types.ObjectId | null; name: string; quantity: number; revenueMinor: number }>([
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.categoryId',
          name: { $first: '$items.categoryNameSnapshot' },
          quantity: { $sum: '$items.quantity' },
          revenueMinor: { $sum: '$items.lineTotalMinor' },
        },
      },
      { $sort: { revenueMinor: -1 } },
      { $project: { _id: 0, categoryId: '$_id', name: 1, quantity: 1, revenueMinor: 1 } },
    ]);
  }

  private async salesByPaymentMethod(match: Record<string, unknown>) {
    return SaleModel.aggregate<{ method: string; orderCount: number; totalMinor: number }>([
      { $match: match },
      { $group: { _id: '$paymentMethod', orderCount: { $sum: 1 }, totalMinor: { $sum: '$totalMinor' } } },
      { $sort: { totalMinor: -1 } },
      { $project: { _id: 0, method: '$_id', orderCount: 1, totalMinor: 1 } },
    ]);
  }

  private async salesByStaff(match: Record<string, unknown>) {
    return SaleModel.aggregate<{ cashierId: Types.ObjectId; name: string; orderCount: number; totalMinor: number }>([
      { $match: match },
      {
        $group: {
          _id: '$cashierId',
          name: { $first: '$cashierNameSnapshot' },
          orderCount: { $sum: 1 },
          totalMinor: { $sum: '$totalMinor' },
        },
      },
      { $sort: { totalMinor: -1 } },
      { $project: { _id: 0, cashierId: '$_id', name: 1, orderCount: 1, totalMinor: 1 } },
    ]);
  }
}

export const reportService = new ReportService();
