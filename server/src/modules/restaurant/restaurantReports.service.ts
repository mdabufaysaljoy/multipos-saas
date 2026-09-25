import type { Types } from 'mongoose';
import { RestaurantOrderModel } from '../../models/RestaurantOrder';
import { RestaurantShiftModel } from '../../models/RestaurantShift';
import { resolveRange } from '../reports/reports.service';
import { recentReturns, returnFiguresFor } from '../../services/returns/posReturns.figures';
import type { ReportRangeInput } from '../reports/reports.validators';
import type { TenantContext } from '../../types/express';
import type { DashboardInput } from './restaurant.validators';

/**
 * Restaurant Advanced Analytics for the current branch: menu performance,
 * voids and cancellations, discounts, kitchen speed and cash-drawer variance.
 *
 * Gated behind the `advancedReports` feature at the route, exactly like the
 * Clothing analytics. All figures come from order snapshots.
 */
class RestaurantReportsService {
  async report(ctx: TenantContext, input: DashboardInput) {
    const range = resolveRange({ ...input, granularity: 'day', branch: 'current', limit: 10 } as ReportRangeInput);
    const scope = { tenantId: ctx.tenantId, storeId: ctx.storeId };
    const window = { $gte: range.from, $lte: range.to };
    const paidMatch = { ...scope, status: 'paid', paidAt: window };
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // A kitchen restocks nothing, so a refund takes money out and no cost back.
    const [returns, returnList] = await Promise.all([
      returnFiguresFor(ctx, 'restaurant', range),
      recentReturns(ctx, 'restaurant', range),
    ]);

    const [totals, payments, menu, categories, voids, cancelTotals, cancellations, discounts, kitchen, shifts] = await Promise.all([
      RestaurantOrderModel.aggregate<{ paidOrders: number; netSalesMinor: number; discountsMinor: number; changeMinor: number; unshiftedSalesMinor: number }>([
        { $match: paidMatch },
        {
          $group: {
            _id: null,
            paidOrders: { $sum: 1 },
            netSalesMinor: { $sum: '$totalMinor' },
            discountsMinor: { $sum: '$discountMinor' },
            changeMinor: { $sum: '$changeMinor' },
            unshiftedSalesMinor: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$shiftId', null] }, null] }, '$totalMinor', 0] } },
          },
        },
      ]),
      // Split payment has been accepted here since task 04; this is the
      // breakdown a drawer reconciliation needs, cash net of the change given.
      RestaurantOrderModel.aggregate<{ _id: string; amountMinor: number; orders: number }>([
        { $match: paidMatch },
        { $unwind: '$payments' },
        { $group: { _id: '$payments.method', amountMinor: { $sum: '$payments.amountMinor' }, orders: { $sum: 1 } } },
        { $sort: { amountMinor: -1 } },
      ]),
      RestaurantOrderModel.aggregate<{ _id: Types.ObjectId; name: string; category: string; quantity: number; revenueMinor: number; orders: number }>([
        { $match: paidMatch },
        { $unwind: '$items' },
        { $match: { 'items.quantity': { $gt: 0 } } },
        {
          $group: {
            _id: '$items.menuItemId',
            name: { $last: '$items.nameSnapshot' },
            category: { $last: '$items.categorySnapshot' },
            quantity: { $sum: '$items.quantity' },
            revenueMinor: { $sum: '$items.lineTotalMinor' },
            orders: { $sum: 1 },
          },
        },
        { $sort: { revenueMinor: -1, quantity: -1 } },
        { $limit: 200 },
      ]),
      RestaurantOrderModel.aggregate<{ _id: string; quantity: number; revenueMinor: number }>([
        { $match: paidMatch },
        { $unwind: '$items' },
        { $match: { 'items.quantity': { $gt: 0 } } },
        { $group: { _id: '$items.categorySnapshot', quantity: { $sum: '$items.quantity' }, revenueMinor: { $sum: '$items.lineTotalMinor' } } },
        { $sort: { revenueMinor: -1 } },
      ]),
      RestaurantOrderModel.aggregate<{ _id: Types.ObjectId; name: string; lines: number; quantity: number; valueMinor: number }>([
        { $match: { ...scope, 'items.voidedAt': window } },
        { $unwind: '$items' },
        { $match: { 'items.voidedAt': window } },
        {
          $group: {
            _id: '$items.menuItemId',
            name: { $last: '$items.nameSnapshot' },
            lines: { $sum: 1 },
            quantity: { $sum: '$items.sentQuantity' },
            valueMinor: { $sum: { $multiply: ['$items.sentQuantity', '$items.unitPriceMinor'] } },
          },
        },
        { $sort: { valueMinor: -1 } },
        { $limit: 50 },
      ]),
      RestaurantOrderModel.aggregate<{ orders: number; valueMinor: number }>([
        { $match: { ...scope, status: 'cancelled', cancelledAt: window } },
        { $group: { _id: null, orders: { $sum: 1 }, valueMinor: { $sum: '$subtotalMinor' } } },
      ]),
      RestaurantOrderModel.find({ ...scope, status: 'cancelled', cancelledAt: window })
        .sort({ cancelledAt: -1 })
        .limit(20)
        .select('orderNumber type tableNameSnapshot subtotalMinor cancelReason cancelledAt openedByNameSnapshot')
        .lean(),
      RestaurantOrderModel.aggregate<{ _id: Types.ObjectId | null; name: string; orders: number; discountsMinor: number }>([
        { $match: { ...paidMatch, discountMinor: { $gt: 0 } } },
        { $group: { _id: '$paidBy', name: { $last: '$paidByNameSnapshot' }, orders: { $sum: 1 }, discountsMinor: { $sum: '$discountMinor' } } },
        { $sort: { discountsMinor: -1 } },
        { $limit: 20 },
      ]),
      RestaurantOrderModel.aggregate<{
        overall: { tickets: number; averageSeconds: number; slowestSeconds: number }[];
        byHour: { _id: string; tickets: number; averageSeconds: number }[];
      }>([
        { $match: { ...scope, 'tickets.readyAt': window } },
        { $unwind: '$tickets' },
        { $match: { 'tickets.status': 'ready', 'tickets.readyAt': window } },
        {
          $project: {
            seconds: { $divide: [{ $subtract: ['$tickets.readyAt', '$tickets.createdAt'] }, 1000] },
            hour: { $dateToString: { format: '%H:00', date: '$tickets.createdAt', timezone } },
          },
        },
        {
          $facet: {
            overall: [{ $group: { _id: null, tickets: { $sum: 1 }, averageSeconds: { $avg: '$seconds' }, slowestSeconds: { $max: '$seconds' } } }],
            byHour: [{ $group: { _id: '$hour', tickets: { $sum: 1 }, averageSeconds: { $avg: '$seconds' } } }, { $sort: { _id: 1 } }],
          },
        },
      ]),
      RestaurantShiftModel.find({ ...scope, status: 'closed', closedAt: window })
        .sort({ closedAt: -1 })
        .limit(50)
        .select('shiftNumber openedAt closedAt openedByNameSnapshot closedByNameSnapshot openingFloatMinor expectedCashMinor countedCashMinor varianceMinor')
        .lean(),
    ]);

    const t = totals[0];
    const k = kitchen[0];
    const overall = k?.overall[0];

    return {
      range: { from: range.from, to: range.to, label: range.label, preset: input.preset },
      totals: {
        paidOrders: t?.paidOrders ?? 0,
        // What was charged, what was refunded, and what the restaurant kept.
        grossSalesMinor: t?.netSalesMinor ?? 0,
        returnCount: returns.count,
        returnAmountMinor: returns.totalMinor,
        netSalesMinor: (t?.netSalesMinor ?? 0) - returns.totalMinor,
        discountsMinor: t?.discountsMinor ?? 0,
        // Paid while no shift was open: money not reconciled against a drawer count.
        unshiftedSalesMinor: t?.unshiftedSalesMinor ?? 0,
      },
      menu: menu.map((row) => ({
        menuItemId: row._id,
        name: row.name,
        category: row.category || 'General',
        quantity: row.quantity,
        orders: row.orders,
        revenueMinor: row.revenueMinor,
      })),
      categories: categories.map((row) => ({ category: row._id || 'General', quantity: row.quantity, revenueMinor: row.revenueMinor })),
      // Cash is reported net of the change handed back, so the methods add up
      // to what was actually taken.
      payments: payments.map((row) => ({
        method: row._id,
        orders: row.orders,
        amountMinor: row._id === 'cash' ? row.amountMinor - (t?.changeMinor ?? 0) : row.amountMinor,
      })),
      returns: { count: returns.count, units: returns.units, amountMinor: returns.totalMinor, recent: returnList },
      voids: {
        lines: voids.reduce((sum, row) => sum + row.lines, 0),
        quantity: voids.reduce((sum, row) => sum + row.quantity, 0),
        valueMinor: voids.reduce((sum, row) => sum + row.valueMinor, 0),
        byItem: voids.map((row) => ({ menuItemId: row._id, name: row.name, lines: row.lines, quantity: row.quantity, valueMinor: row.valueMinor })),
      },
      cancellations: {
        orders: cancelTotals[0]?.orders ?? 0,
        valueMinor: cancelTotals[0]?.valueMinor ?? 0,
        recent: cancellations,
      },
      discounts: {
        totalMinor: t?.discountsMinor ?? 0,
        byStaff: discounts.map((row) => ({ userId: row._id, name: row.name || 'Unknown', orders: row.orders, discountsMinor: row.discountsMinor })),
      },
      kitchen: {
        tickets: overall?.tickets ?? 0,
        averagePrepSeconds: Math.round(overall?.averageSeconds ?? 0),
        slowestPrepSeconds: Math.round(overall?.slowestSeconds ?? 0),
        byHour: (k?.byHour ?? []).map((row) => ({ hour: row._id, tickets: row.tickets, averagePrepSeconds: Math.round(row.averageSeconds) })),
      },
      shifts: {
        closed: shifts.length,
        totalVarianceMinor: shifts.reduce((sum, s) => sum + (s.varianceMinor ?? 0), 0),
        shortShifts: shifts.filter((s) => (s.varianceMinor ?? 0) < 0).length,
        list: shifts,
      },
    };
  }
}

export const restaurantReportsService = new RestaurantReportsService();
