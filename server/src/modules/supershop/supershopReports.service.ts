import type { Types } from 'mongoose';
import type { ShopUnitType } from '../../models/ShopProduct';
import { ShopSaleModel } from '../../models/ShopSale';
import { ShopStockModel } from '../../models/ShopStock';
import { ShopStockMovementModel } from '../../models/ShopStockMovement';
import { resolveRange, reportTimezone } from '../reports/reports.service';
import { NO_RETURNS, recentReturns, returnFiguresFor, returnsByDay } from '../../services/returns/posReturns.figures';
import type { ReportRangeInput } from '../reports/reports.validators';
import type { ShopAnalyticsInput } from './supershop.validators';
import { StoreModel } from '../../models/Store';
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
  /**
   * Which branches this request may look at.
   *
   * The same rule Clothing has always used: "all" and a named branch are an
   * administrator's to ask for, and anyone else is quietly given their own
   * branch rather than an error - so a dashboard link shared with a branch
   * manager shows them their own numbers instead of leaking another shop's.
   * It is decided HERE, in the query, never in the client.
   */
  private storeScope(ctx: TenantContext, branch: ShopAnalyticsInput['branch']): Record<string, unknown> {
    if (branch === 'all') return ctx.isAdmin ? {} : { storeId: ctx.storeId };
    if (branch === 'current' || !branch) return { storeId: ctx.storeId };
    if (!ctx.isAdmin) return { storeId: ctx.storeId };
    return { storeId: branch };
  }

  async report(ctx: TenantContext, input: ShopAnalyticsInput) {
    const range = resolveRange({ ...input, granularity: 'day', branch: 'current', limit: input.limit } as ReportRangeInput);
    const scope = { tenantId: ctx.tenantId, ...this.storeScope(ctx, input.branch) };
    const window = { $gte: range.from, $lte: range.to };
    const timezone = reportTimezone();
    const limit = input.limit;

    // ---- the filters ---------------------------------------------------------
    // Sale-level: they choose which sales are counted, so everything narrows.
    const saleFilters: Record<string, unknown> = {};
    if (input.staffId) saleFilters.cashierId = input.staffId;
    if (input.customerId) saleFilters.customerId = input.customerId;
    if (input.paymentMethod) saleFilters['payments.method'] = input.paymentMethod;

    // Line-level: they choose which LINES are of interest. A sale is counted
    // when it contains such a line; the line breakdowns below show only those
    // lines, and `selection` reports them on their own.
    const lineFilter: Record<string, unknown> = {};
    if (input.category) lineFilter['items.categorySnapshot'] = input.category;
    if (input.brand) lineFilter['items.brandSnapshot'] = input.brand;
    if (input.productId) lineFilter['items.productId'] = input.productId;
    const hasLineFilter = Object.keys(lineFilter).length > 0;

    const completed = { ...scope, status: 'completed', soldAt: window, ...saleFilters, ...lineFilter };

    /** The `$match` that keeps only the lines the filter asked about. */
    const lineMatch = hasLineFilter
      ? [
          {
            $match: Object.fromEntries(
              Object.entries(lineFilter).map(([key, value]) => [key.replace('items.', 'items.'), value]),
            ),
          },
        ]
      : [];

    /**
     * What was charged is on the sales; what was KEPT is that less what came
     * back. Returns have to narrow with the same filters, or a filtered report
     * would subtract refunds that have nothing to do with what was asked.
     *
     * A return knows its branch, its date and its customer, so those filters it
     * can honour. It does NOT know which cashier made the original sale, which
     * tender that sale was paid on, or which department a filtered line sat in -
     * so under those filters returns are NOT ATTRIBUTABLE, and the honest answer
     * is to leave them out and say so rather than subtract the wrong number.
     */
    const returnScope: Record<string, unknown> = { ...this.storeScope(ctx, input.branch) };
    if (input.customerId) returnScope.customerId = input.customerId;
    const returnsAttributable = !input.staffId && !input.paymentMethod && !hasLineFilter;

    const [returns, refundsByDay, returnList] = returnsAttributable
      ? await Promise.all([
          returnFiguresFor(ctx, 'supershop', range, returnScope),
          returnsByDay(ctx, 'supershop', range, timezone, returnScope),
          recentReturns(ctx, 'supershop', range, 10, returnScope),
        ])
      : [NO_RETURNS, new Map<string, { totalMinor: number; costMinor: number }>(), []];

    const [totals, trend, products, departments, vatRates, hours, payments, discounts, byStaff, byBrand, byBranch, byCustomer, selectionRows, branches, voidTotals, voids, writeOffs, deadStock] = await Promise.all([
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
        ...lineMatch,
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
        ...lineMatch,
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
        ...lineMatch,
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
      // ---- who sold it: staff -------------------------------------------------
      ShopSaleModel.aggregate<{ _id: Types.ObjectId; name: string; salesCount: number; netSalesMinor: number; vatMinor: number; costMinor: number; discountsMinor: number }>([
        { $match: completed },
        {
          $group: {
            _id: '$cashierId',
            name: { $last: '$cashierNameSnapshot' },
            salesCount: { $sum: 1 },
            netSalesMinor: { $sum: '$totalMinor' },
            vatMinor: { $sum: '$vatMinor' },
            costMinor: { $sum: '$costMinor' },
            discountsMinor: { $sum: '$discountMinor' },
          },
        },
        { $sort: { netSalesMinor: -1 } },
        { $limit: limit },
      ]),
      // ---- under whose name: brand --------------------------------------------
      ShopSaleModel.aggregate<{ _id: string; lines: number; quantity: number; revenueMinor: number; vatMinor: number; costMinor: number }>([
        { $match: completed },
        { $unwind: '$items' },
        ...lineMatch,
        { $match: { 'items.brandSnapshot': { $nin: ['', null] } } },
        {
          $group: {
            _id: '$items.brandSnapshot',
            lines: { $sum: 1 },
            quantity: { $sum: '$items.quantity' },
            revenueMinor: { $sum: '$items.lineTotalMinor' },
            vatMinor: { $sum: '$items.vatMinor' },
            costMinor: { $sum: '$items.costMinor' },
          },
        },
        { $sort: { revenueMinor: -1 } },
        { $limit: limit },
      ]),
      // ---- which shop: branch. Only meaningful when more than one is in scope.
      ShopSaleModel.aggregate<{ _id: Types.ObjectId; salesCount: number; netSalesMinor: number; vatMinor: number; costMinor: number }>([
        { $match: completed },
        {
          $group: {
            _id: '$storeId',
            salesCount: { $sum: 1 },
            netSalesMinor: { $sum: '$totalMinor' },
            vatMinor: { $sum: '$vatMinor' },
            costMinor: { $sum: '$costMinor' },
          },
        },
        { $sort: { netSalesMinor: -1 } },
      ]),
      // ---- who bought it: customer. Walk-in sales carry none and are skipped.
      ShopSaleModel.aggregate<{ _id: Types.ObjectId; name: string; salesCount: number; netSalesMinor: number }>([
        { $match: { ...completed, customerId: { $ne: null } } },
        { $group: { _id: '$customerId', name: { $last: '$customerNameSnapshot' }, salesCount: { $sum: 1 }, netSalesMinor: { $sum: '$totalMinor' } } },
        { $sort: { netSalesMinor: -1 } },
        { $limit: limit },
      ]),
      // ---- the lines a line-filter actually selected --------------------------
      hasLineFilter
        ? ShopSaleModel.aggregate<{ lines: number; quantity: number; revenueMinor: number; vatMinor: number; costMinor: number; sales: Types.ObjectId[] }>([
            { $match: completed },
            { $unwind: '$items' },
            ...lineMatch,
            {
              $group: {
                _id: null,
                lines: { $sum: 1 },
                quantity: { $sum: '$items.quantity' },
                revenueMinor: { $sum: '$items.lineTotalMinor' },
                vatMinor: { $sum: '$items.vatMinor' },
                costMinor: { $sum: '$items.costMinor' },
                sales: { $addToSet: '$_id' },
              },
            },
          ])
        : Promise.resolve([]),
      // ---- the branches this request may look at, for the picker -------------
      StoreModel.find(ctx.isAdmin ? { tenantId: ctx.tenantId } : { _id: ctx.storeId, tenantId: ctx.tenantId })
        .select('name')
        .sort({ name: 1 })
        .lean(),
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
        // MongoDB does not promise an order out of `$group`, so without this the
        // same report could print its write-offs in a different order each time.
        { $sort: { quantity: -1, _id: 1 } },
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
    // What was charged, what came back, and what the shop actually kept.
    const grossSalesMinor = t?.netSalesMinor ?? 0;
    const netSalesMinor = grossSalesMinor - returns.totalMinor;
    const vatMinor = t?.vatMinor ?? 0;
    // Goods that went back on the shelf take their cost out of profit with them.
    const costMinor = (t?.costMinor ?? 0) - returns.costMinor;
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

    const branchNames = new Map(branches.map((row) => [String(row._id), row.name]));
    const selection = selectionRows[0] ?? null;

    return {
      range: { from: range.from, to: range.to, label: range.label, preset: input.preset },
      /**
       * What was actually applied, resolved on the server. `branch` is what the
       * request was GIVEN, not necessarily what it asked for: a non-admin who
       * asks for "all" is reported back their own branch.
       */
      filters: {
        branch: input.branch === 'all' && ctx.isAdmin ? 'all' : String(this.storeScope(ctx, input.branch).storeId ?? 'all'),
        requestedBranch: String(input.branch),
        staffId: input.staffId ? String(input.staffId) : null,
        customerId: input.customerId ? String(input.customerId) : null,
        paymentMethod: input.paymentMethod ?? null,
        category: input.category ?? null,
        brand: input.brand ?? null,
        productId: input.productId ? String(input.productId) : null,
      },
      /**
       * False when a filter is on that a return cannot be attributed to - a
       * cashier, a tender, or a line. Returns are then left out of the figures
       * entirely rather than subtracted wrongly, and the screen says so.
       */
      returnsAttributable,
      /** The branches this user may choose between. One, for a non-admin. */
      branches: branches.map((row) => ({ _id: row._id, name: row.name })),
      /**
       * Present only when a category, brand or product filter is on: those
       * LINES on their own. Sale totals above stay sale totals - a basket is not
       * re-costed because one line was asked about.
       */
      selection: selection
        ? {
            lines: selection.lines,
            salesCount: selection.sales.length,
            quantity: selection.quantity,
            revenueMinor: selection.revenueMinor,
            vatMinor: selection.vatMinor,
            costMinor: selection.costMinor,
            profitMinor: selection.revenueMinor - selection.vatMinor - selection.costMinor,
            marginBps: marginBps(selection.revenueMinor - selection.vatMinor - selection.costMinor, selection.revenueMinor - selection.vatMinor),
          }
        : null,
      totals: {
        salesCount: t?.salesCount ?? 0,
        grossSalesMinor,
        returnCount: returns.count,
        returnAmountMinor: returns.totalMinor,
        netSalesMinor,
        discountsMinor: t?.discountsMinor ?? 0,
        vatMinor,
        costMinor,
        grossProfitMinor,
        marginBps: marginBps(grossProfitMinor, netSalesMinor - vatMinor),
        averageBasketMinor: t?.salesCount ? Math.round(grossSalesMinor / t.salesCount) : 0,
        averageLines: t?.salesCount ? Math.round((t.lines / t.salesCount) * 10) / 10 : 0,
      },
      trend: trend.map((row) => {
        const refunded = refundsByDay.get(row._id) ?? { totalMinor: 0, costMinor: 0 };
        return {
          date: row._id,
          salesCount: row.salesCount,
          grossSalesMinor: row.netSalesMinor,
          returnAmountMinor: refunded.totalMinor,
          netSalesMinor: row.netSalesMinor - refunded.totalMinor,
          vatMinor: row.vatMinor,
          // Same arithmetic as the totals: returned goods take their cost back too.
          grossProfitMinor: row.netSalesMinor - refunded.totalMinor - row.vatMinor - (row.costMinor - refunded.costMinor),
        };
      }),
      // Product, department and VAT-rate figures are per line, before any
      // sale-level discount and before anything came back.
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
      // ---- the dimensions ------------------------------------------------------
      // Staff, branch and customer are SALE-level, so their figures are whole
      // baskets. Brand is per line, like products and departments.
      staff: byStaff.map((row) => {
        const profitMinor = row.netSalesMinor - row.vatMinor - row.costMinor;
        return {
          userId: row._id,
          name: row.name || 'Unknown',
          salesCount: row.salesCount,
          netSalesMinor: row.netSalesMinor,
          vatMinor: row.vatMinor,
          costMinor: row.costMinor,
          discountsMinor: row.discountsMinor,
          profitMinor,
          marginBps: marginBps(profitMinor, row.netSalesMinor - row.vatMinor),
          averageBasketMinor: row.salesCount ? Math.round(row.netSalesMinor / row.salesCount) : 0,
        };
      }),
      brands: byBrand.map((row) => {
        const profitMinor = row.revenueMinor - row.vatMinor - row.costMinor;
        return {
          brand: row._id,
          lines: row.lines,
          quantity: row.quantity,
          revenueMinor: row.revenueMinor,
          vatMinor: row.vatMinor,
          costMinor: row.costMinor,
          profitMinor,
          marginBps: marginBps(profitMinor, row.revenueMinor - row.vatMinor),
        };
      }),
      branchBreakdown: byBranch.map((row) => {
        const profitMinor = row.netSalesMinor - row.vatMinor - row.costMinor;
        return {
          storeId: row._id,
          name: branchNames.get(String(row._id)) ?? 'Another branch',
          salesCount: row.salesCount,
          netSalesMinor: row.netSalesMinor,
          vatMinor: row.vatMinor,
          costMinor: row.costMinor,
          profitMinor,
          marginBps: marginBps(profitMinor, row.netSalesMinor - row.vatMinor),
        };
      }),
      customers: byCustomer.map((row) => ({
        customerId: row._id,
        name: row.name || 'Unknown',
        salesCount: row.salesCount,
        netSalesMinor: row.netSalesMinor,
        averageBasketMinor: row.salesCount ? Math.round(row.netSalesMinor / row.salesCount) : 0,
      })),
      // What came back, next to what was voided: a void cancels a sale, a
      // return gives money back on one that stands.
      returns: { count: returns.count, units: returns.units, amountMinor: returns.totalMinor, costMinor: returns.costMinor, recent: returnList },
      voids: { count: voidTotals[0]?.count ?? 0, valueMinor: voidTotals[0]?.valueMinor ?? 0, recent: voids },
      writeOffs: { costMinor: writeOffRows.reduce((sum, row) => sum + row.costMinor, 0), byProduct: writeOffRows.slice(0, 10) },
      deadStock: dead,
    };
  }
}

export const supershopReportsService = new SupershopReportsService();
