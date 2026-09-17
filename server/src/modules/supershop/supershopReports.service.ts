import type { Types } from 'mongoose';
import type { ShopUnitType } from '../../models/ShopProduct';
import { ShopSaleModel } from '../../models/ShopSale';
import { ShopStockModel } from '../../models/ShopStock';
import { ShopStockMovementModel } from '../../models/ShopStockMovement';
import { resolveRange } from '../reports/reports.service';
import type { AnalyticsRangeInput, ReportRangeInput } from '../reports/reports.validators';
import type { TenantContext } from '../../types/express';
import { lineAmount } from './supershop.service';

/** Gross profit as basis points of revenue excluding VAT (1234 = 12.34%). */
const marginBps = (profitMinor: number, revenueExVatMinor: number) =>
  revenueExVatMinor > 0 ? Math.round((profitMinor * 10_000) / revenueExVatMinor) : 0;

/**
 * Supershop Advanced Analytics for the current branch: sales, VAT and margin,
 * product and department performance, VAT by rate, busy hours, payments,
 * discounts, voids, write-offs and dead stock.
 *
 * Gated behind the `advancedReports` feature at the route, like the other
 * verticals. Sales figures come from sale snapshots; stock figures are the
 * branch's stock as it stands now, valued at average cost.
 *
 * Gross profit = net sales − VAT − cost of goods: VAT is collected for the
 * government, not earned.
 */
class SupershopReportsService {
  async report(ctx: TenantContext, input: AnalyticsRangeInput) {
    const range = resolveRange({ ...input, granularity: 'day', branch: 'current', limit: 10 } as ReportRangeInput);
    const scope = { tenantId: ctx.tenantId, storeId: ctx.storeId };
    const window = { $gte: range.from, $lte: range.to };
    const completed = { ...scope, status: 'completed', soldAt: window };
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const [totals, trend, products, departments, vatRates, hours, payments, discounts, voidTotals, voids, writeOffs, deadStock] = await Promise.all([
      ShopSaleModel.aggregate<{ salesCount: number; netSalesMinor: number; discountsMinor: number; vatMinor: number; costMinor: number; changeMinor: number; lines: number }>([
        { $match: completed },
        {
          $group: {
            _id: null,
            salesCount: { $sum: 1 },
            netSalesMinor: { $sum: '$totalMinor' },
            discountsMinor: { $sum: '$discountMinor' },
            vatMinor: { $sum: '$vatMinor' },
            costMinor: { $sum: '$costMinor' },
            changeMinor: { $sum: '$changeMinor' },
            lines: { $sum: { $size: '$items' } },
          },
        },
      ]),
      ShopSaleModel.aggregate<{ _id: string; salesCount: number; netSalesMinor: number; vatMinor: number; costMinor: number }>([
        { $match: completed },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$soldAt', timezone } },
            salesCount: { $sum: 1 },
            netSalesMinor: { $sum: '$totalMinor' },
            vatMinor: { $sum: '$vatMinor' },
            costMinor: { $sum: '$costMinor' },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      ShopSaleModel.aggregate<{ _id: Types.ObjectId; name: string; unitType: ShopUnitType; quantity: number; revenueMinor: number; vatMinor: number; costMinor: number }>([
        { $match: completed },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.productId',
            name: { $last: '$items.nameSnapshot' },
            unitType: { $last: '$items.unitType' },
            quantity: { $sum: '$items.quantity' },
            revenueMinor: { $sum: '$items.lineTotalMinor' },
            vatMinor: { $sum: '$items.vatMinor' },
            costMinor: { $sum: '$items.costMinor' },
          },
        },
        { $sort: { revenueMinor: -1 } },
        { $limit: 50 },
      ]),
      ShopSaleModel.aggregate<{ _id: string; lines: number; revenueMinor: number; vatMinor: number; costMinor: number }>([
        { $match: completed },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.categorySnapshot',
            lines: { $sum: 1 },
            revenueMinor: { $sum: '$items.lineTotalMinor' },
            vatMinor: { $sum: '$items.vatMinor' },
            costMinor: { $sum: '$items.costMinor' },
          },
        },
        { $sort: { revenueMinor: -1 } },
      ]),
      ShopSaleModel.aggregate<{ _id: number; grossMinor: number; vatMinor: number; lines: number }>([
        { $match: completed },
        { $unwind: '$items' },
        { $group: { _id: '$items.vatRateBps', grossMinor: { $sum: '$items.lineTotalMinor' }, vatMinor: { $sum: '$items.vatMinor' }, lines: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      ShopSaleModel.aggregate<{ _id: string; salesCount: number; netSalesMinor: number }>([
        { $match: completed },
        { $group: { _id: { $dateToString: { format: '%H', date: '$soldAt', timezone } }, salesCount: { $sum: 1 }, netSalesMinor: { $sum: '$totalMinor' } } },
        { $sort: { _id: 1 } },
      ]),
      ShopSaleModel.aggregate<{ _id: string; amountMinor: number; sales: number }>([
        { $match: completed },
        { $unwind: '$payments' },
        { $group: { _id: '$payments.method', amountMinor: { $sum: '$payments.amountMinor' }, sales: { $sum: 1 } } },
        { $sort: { amountMinor: -1 } },
      ]),
      ShopSaleModel.aggregate<{ _id: Types.ObjectId; name: string; sales: number; discountsMinor: number }>([
        { $match: { ...completed, discountMinor: { $gt: 0 } } },
        { $group: { _id: '$cashierId', name: { $last: '$cashierNameSnapshot' }, sales: { $sum: 1 }, discountsMinor: { $sum: '$discountMinor' } } },
        { $sort: { discountsMinor: -1 } },
        { $limit: 20 },
      ]),
      ShopSaleModel.aggregate<{ count: number; valueMinor: number }>([
        { $match: { ...scope, status: 'voided', voidedAt: window } },
        { $group: { _id: null, count: { $sum: 1 }, valueMinor: { $sum: '$totalMinor' } } },
      ]),
      ShopSaleModel.find({ ...scope, status: 'voided', voidedAt: window })
        .sort({ voidedAt: -1 })
        .limit(10)
        .select('saleNumber totalMinor voidReason voidedAt voidedByNameSnapshot')
        .lean(),
      ShopStockMovementModel.aggregate<{ _id: Types.ObjectId; name: string; unitType: ShopUnitType; quantity: number }>([
        { $match: { ...scope, type: 'write_off', createdAt: window } },
        { $group: { _id: '$productId', name: { $last: '$productNameSnapshot' }, unitType: { $last: '$unitType' }, quantity: { $sum: { $multiply: ['$quantity', -1] } } } },
      ]),
      // Stock of products that did not sell at all in the period.
      (async () => {
        const sold = await ShopSaleModel.distinct('items.productId', completed);
        return ShopStockModel.find({ ...scope, quantityOnHand: { $gt: 0 }, productId: { $nin: sold } })
          .populate<{ productId: { _id: Types.ObjectId; name: string; unitType: ShopUnitType; deletedAt: Date | null } | null }>('productId', 'name unitType deletedAt')
          .limit(500)
          .lean();
      })(),
    ]);

    // Write-offs are valued at the branch's current average cost.
    const writeOffCosts = new Map(
      (await ShopStockModel.find({ ...scope, productId: { $in: writeOffs.map((row) => row._id) } }).select('productId costPriceMinor').lean()).map((row) => [
        String(row.productId),
        row.costPriceMinor,
      ]),
    );
    const writeOffRows = writeOffs
      .map((row) => ({
        productId: row._id,
        name: row.name,
        unitType: row.unitType,
        quantity: row.quantity,
        costMinor: lineAmount(writeOffCosts.get(String(row._id)) ?? 0, row.quantity, row.unitType),
      }))
      .sort((a, b) => b.costMinor - a.costMinor);

    const t = totals[0];
    const netSalesMinor = t?.netSalesMinor ?? 0;
    const vatMinor = t?.vatMinor ?? 0;
    const costMinor = t?.costMinor ?? 0;
    const grossProfitMinor = netSalesMinor - vatMinor - costMinor;
    const dead = deadStock
      .filter((row) => row.productId && !row.productId.deletedAt)
      .map((row) => ({
        productId: row.productId!._id,
        name: row.productId!.name,
        unitType: row.productId!.unitType,
        quantityOnHand: row.quantityOnHand,
        stockCostMinor: lineAmount(row.costPriceMinor, row.quantityOnHand, row.productId!.unitType),
      }))
      .sort((a, b) => b.stockCostMinor - a.stockCostMinor)
      .slice(0, 20);

    return {
      range: { from: range.from, to: range.to, label: range.label, preset: input.preset },
      totals: {
        salesCount: t?.salesCount ?? 0,
        netSalesMinor,
        discountsMinor: t?.discountsMinor ?? 0,
        vatMinor,
        costMinor,
        grossProfitMinor,
        marginBps: marginBps(grossProfitMinor, netSalesMinor - vatMinor),
        averageBasketMinor: t?.salesCount ? Math.round(netSalesMinor / t.salesCount) : 0,
        averageLines: t?.salesCount ? Math.round((t.lines / t.salesCount) * 10) / 10 : 0,
      },
      trend: trend.map((row) => ({
        date: row._id,
        salesCount: row.salesCount,
        netSalesMinor: row.netSalesMinor,
        vatMinor: row.vatMinor,
        grossProfitMinor: row.netSalesMinor - row.vatMinor - row.costMinor,
      })),
      // Product, department and VAT-rate figures are per line, before any sale-level discount.
      products: products.map((row) => {
        const profitMinor = row.revenueMinor - row.vatMinor - row.costMinor;
        return {
          productId: row._id,
          name: row.name,
          unitType: row.unitType,
          quantity: row.quantity,
          revenueMinor: row.revenueMinor,
          vatMinor: row.vatMinor,
          costMinor: row.costMinor,
          profitMinor,
          marginBps: marginBps(profitMinor, row.revenueMinor - row.vatMinor),
        };
      }),
      departments: departments.map((row) => ({
        department: row._id || 'General',
        lines: row.lines,
        revenueMinor: row.revenueMinor,
        profitMinor: row.revenueMinor - row.vatMinor - row.costMinor,
      })),
      vatRates: vatRates.map((row) => ({ vatRateBps: row._id ?? 0, lines: row.lines, grossMinor: row.grossMinor, vatMinor: row.vatMinor, netOfVatMinor: row.grossMinor - row.vatMinor })),
      hours: hours.map((row) => ({ hour: row._id, salesCount: row.salesCount, netSalesMinor: row.netSalesMinor })),
      payments: payments.map((row) => ({
        method: row._id,
        sales: row.sales,
        amountMinor: row._id === 'cash' ? row.amountMinor - (t?.changeMinor ?? 0) : row.amountMinor,
      })),
      discounts: {
        totalMinor: t?.discountsMinor ?? 0,
        byStaff: discounts.map((row) => ({ userId: row._id, name: row.name || 'Unknown', sales: row.sales, discountsMinor: row.discountsMinor })),
      },
      voids: { count: voidTotals[0]?.count ?? 0, valueMinor: voidTotals[0]?.valueMinor ?? 0, recent: voids },
      writeOffs: { costMinor: writeOffRows.reduce((sum, row) => sum + row.costMinor, 0), byProduct: writeOffRows.slice(0, 10) },
      deadStock: dead,
    };
  }
}

export const supershopReportsService = new SupershopReportsService();
