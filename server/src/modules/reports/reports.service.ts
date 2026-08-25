import { Types } from 'mongoose';
import dayjs from 'dayjs';
import { SALE_STATUS } from '../../config/constants';
import { ReturnModel } from '../../models/Return';
import { SaleModel } from '../../models/Sale';
import type { TenantContext } from '../../types/express';
import type { ReportRangeInput } from './reports.validators';

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

const DATE_FORMAT: Record<string, string> = { day: '%Y-%m-%d', week: '%G-W%V', month: '%Y-%m' };

/**
 * Every figure here is produced by a MongoDB aggregation. Sales are never
 * shipped to the browser to be summed client-side, so the dashboard stays fast
 * across years of history.
 */
class ReportService {
  private saleMatch(ctx: TenantContext, range: ResolvedRange, input: ReportRangeInput) {
    const match: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      status: SALE_STATUS.COMPLETED,
      soldAt: { $gte: range.from, $lte: range.to },
    };
    if (input.cashierId) match.cashierId = input.cashierId;
    return match;
  }

  async dashboard(ctx: TenantContext, input: ReportRangeInput) {
    const range = resolveRange(input);
    const match = this.saleMatch(ctx, range, input);

    const [summary, returns, trend, topProducts, topVariants, byCategory, byPaymentMethod, byStaff] = await Promise.all([
      this.summary(match),
      this.returnSummary(ctx, range),
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

  private async returnSummary(ctx: TenantContext, range: ResolvedRange) {
    const [row] = await ReturnModel.aggregate<{ totalMinor: number; count: number; items: number }>([
      {
        $match: {
          tenantId: ctx.tenantId,
          storeId: ctx.storeId,
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
          _id: { $dateToString: { format: DATE_FORMAT[granularity] ?? DATE_FORMAT.day, date: '$soldAt' } },
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
