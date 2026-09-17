import type { Types } from 'mongoose';
import { MedicineModel } from '../../models/Medicine';
import { MedicineBatchModel } from '../../models/MedicineBatch';
import { PharmacySaleModel } from '../../models/PharmacySale';
import { PharmacyStockMovementModel } from '../../models/PharmacyStockMovement';
import { resolveRange } from '../reports/reports.service';
import type { AnalyticsRangeInput, ReportRangeInput } from '../reports/reports.validators';
import type { TenantContext } from '../../types/express';
import { todayUtc } from './pharmacy.service';

const DAY_MS = 86_400_000;

/** Gross profit as basis points of net sales (1234 = 12.34%). */
const marginBps = (profitMinor: number, revenueMinor: number) => (revenueMinor > 0 ? Math.round((profitMinor * 10_000) / revenueMinor) : 0);

/** Cost of one sale line: the batches it actually came from, at their cost. */
const lineCost = { $sum: { $map: { input: '$items.allocations', as: 'a', in: { $multiply: ['$$a.quantity', '$$a.costPriceMinor'] } } } };

/**
 * Pharmacy Advanced Analytics for the current branch: sales and margin,
 * medicine performance, prescriptions, payments, discounts, voids, write-offs,
 * expiry exposure and slow-moving stock.
 *
 * Gated behind the `advancedReports` feature at the route, like Clothing and
 * Restaurant. Sales figures come from sale snapshots (prices and batch costs as
 * sold); stock figures are the branch's stock as it stands now.
 */
class PharmacyReportsService {
  async report(ctx: TenantContext, input: AnalyticsRangeInput) {
    const range = resolveRange({ ...input, granularity: 'day', branch: 'current', limit: 10 } as ReportRangeInput);
    const scope = { tenantId: ctx.tenantId, storeId: ctx.storeId };
    const window = { $gte: range.from, $lte: range.to };
    const completed = { ...scope, status: 'completed', soldAt: window };
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = todayUtc();

    const [totals, trend, medicines, dosageForms, payments, discounts, voidTotals, voids, writeOffs, expiry, slowMovers] = await Promise.all([
      PharmacySaleModel.aggregate<{
        salesCount: number;
        netSalesMinor: number;
        discountsMinor: number;
        costMinor: number;
        changeMinor: number;
        prescriptionSales: number;
        prescriptionValueMinor: number;
      }>([
        { $match: completed },
        { $addFields: { hasPrescription: { $cond: [{ $eq: [{ $ifNull: ['$prescription', null] }, null] }, false, true] } } },
        {
          $group: {
            _id: null,
            salesCount: { $sum: 1 },
            netSalesMinor: { $sum: '$totalMinor' },
            discountsMinor: { $sum: '$discountMinor' },
            costMinor: { $sum: '$costMinor' },
            changeMinor: { $sum: '$changeMinor' },
            prescriptionSales: { $sum: { $cond: ['$hasPrescription', 1, 0] } },
            prescriptionValueMinor: { $sum: { $cond: ['$hasPrescription', '$totalMinor', 0] } },
          },
        },
      ]),
      PharmacySaleModel.aggregate<{ _id: string; salesCount: number; netSalesMinor: number; costMinor: number }>([
        { $match: completed },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$soldAt', timezone } },
            salesCount: { $sum: 1 },
            netSalesMinor: { $sum: '$totalMinor' },
            costMinor: { $sum: '$costMinor' },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      PharmacySaleModel.aggregate<{ _id: Types.ObjectId; name: string; strength: string; genericName: string; quantity: number; revenueMinor: number; costMinor: number }>([
        { $match: completed },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.medicineId',
            name: { $last: '$items.nameSnapshot' },
            strength: { $last: '$items.strengthSnapshot' },
            genericName: { $last: '$items.genericNameSnapshot' },
            quantity: { $sum: '$items.quantity' },
            revenueMinor: { $sum: '$items.lineTotalMinor' },
            costMinor: { $sum: lineCost },
          },
        },
        { $sort: { revenueMinor: -1, quantity: -1 } },
        { $limit: 50 },
      ]),
      PharmacySaleModel.aggregate<{ _id: string; quantity: number; revenueMinor: number }>([
        { $match: completed },
        { $unwind: '$items' },
        { $group: { _id: '$items.dosageFormSnapshot', quantity: { $sum: '$items.quantity' }, revenueMinor: { $sum: '$items.lineTotalMinor' } } },
        { $sort: { revenueMinor: -1 } },
      ]),
      PharmacySaleModel.aggregate<{ _id: string; amountMinor: number; sales: number }>([
        { $match: completed },
        { $unwind: '$payments' },
        { $group: { _id: '$payments.method', amountMinor: { $sum: '$payments.amountMinor' }, sales: { $sum: 1 } } },
        { $sort: { amountMinor: -1 } },
      ]),
      PharmacySaleModel.aggregate<{ _id: Types.ObjectId; name: string; sales: number; discountsMinor: number }>([
        { $match: { ...completed, discountMinor: { $gt: 0 } } },
        { $group: { _id: '$cashierId', name: { $last: '$cashierNameSnapshot' }, sales: { $sum: 1 }, discountsMinor: { $sum: '$discountMinor' } } },
        { $sort: { discountsMinor: -1 } },
        { $limit: 20 },
      ]),
      PharmacySaleModel.aggregate<{ count: number; valueMinor: number }>([
        { $match: { ...scope, status: 'voided', voidedAt: window } },
        { $group: { _id: null, count: { $sum: 1 }, valueMinor: { $sum: '$totalMinor' } } },
      ]),
      PharmacySaleModel.find({ ...scope, status: 'voided', voidedAt: window })
        .sort({ voidedAt: -1 })
        .limit(10)
        .select('saleNumber totalMinor voidReason voidedAt voidedByNameSnapshot')
        .lean(),
      PharmacyStockMovementModel.aggregate<{ _id: Types.ObjectId; name: string; units: number; costMinor: number }>([
        { $match: { ...scope, type: 'write_off', createdAt: window } },
        { $lookup: { from: MedicineBatchModel.collection.name, localField: 'batchId', foreignField: '_id', as: 'batch' } },
        {
          $project: {
            medicineId: 1,
            name: '$medicineNameSnapshot',
            units: { $multiply: ['$quantity', -1] },
            cost: { $ifNull: [{ $arrayElemAt: ['$batch.costPriceMinor', 0] }, 0] },
          },
        },
        { $group: { _id: '$medicineId', name: { $last: '$name' }, units: { $sum: '$units' }, costMinor: { $sum: { $multiply: ['$units', '$cost'] } } } },
        { $sort: { costMinor: -1 } },
      ]),
      MedicineBatchModel.aggregate<{ _id: string; units: number; costMinor: number }>([
        { $match: { ...scope, quantityOnHand: { $gt: 0 } } },
        {
          $project: {
            quantityOnHand: 1,
            value: { $multiply: ['$quantityOnHand', '$costPriceMinor'] },
            bucket: {
              $switch: {
                branches: [
                  { case: { $lt: ['$expiryDate', today] }, then: 'expired' },
                  { case: { $lt: ['$expiryDate', new Date(today.getTime() + 31 * DAY_MS)] }, then: 'within30' },
                  { case: { $lt: ['$expiryDate', new Date(today.getTime() + 61 * DAY_MS)] }, then: 'within60' },
                  { case: { $lt: ['$expiryDate', new Date(today.getTime() + 91 * DAY_MS)] }, then: 'within90' },
                ],
                default: 'later',
              },
            },
          },
        },
        { $group: { _id: '$bucket', units: { $sum: '$quantityOnHand' }, costMinor: { $sum: '$value' } } },
      ]),
      // Sellable stock of medicines that did not sell at all in the period.
      (async () => {
        const sold = await PharmacySaleModel.distinct('items.medicineId', completed);
        return MedicineBatchModel.aggregate<{ _id: Types.ObjectId; units: number; stockCostMinor: number; name: string | null; strength: string | null }>([
          { $match: { ...scope, quantityOnHand: { $gt: 0 }, expiryDate: { $gte: today }, medicineId: { $nin: sold } } },
          { $group: { _id: '$medicineId', units: { $sum: '$quantityOnHand' }, stockCostMinor: { $sum: { $multiply: ['$quantityOnHand', '$costPriceMinor'] } } } },
          { $sort: { stockCostMinor: -1 } },
          { $limit: 20 },
          { $lookup: { from: MedicineModel.collection.name, localField: '_id', foreignField: '_id', as: 'medicine' } },
          {
            $project: {
              units: 1,
              stockCostMinor: 1,
              name: { $arrayElemAt: ['$medicine.name', 0] },
              strength: { $arrayElemAt: ['$medicine.strength', 0] },
            },
          },
        ]);
      })(),
    ]);

    const t = totals[0];
    const netSalesMinor = t?.netSalesMinor ?? 0;
    const costMinor = t?.costMinor ?? 0;
    const grossProfitMinor = netSalesMinor - costMinor;
    const bucket = (name: string) => {
      const row = expiry.find((entry) => entry._id === name);
      return { units: row?.units ?? 0, costMinor: row?.costMinor ?? 0 };
    };

    return {
      range: { from: range.from, to: range.to, label: range.label, preset: input.preset },
      totals: {
        salesCount: t?.salesCount ?? 0,
        netSalesMinor,
        discountsMinor: t?.discountsMinor ?? 0,
        costMinor,
        grossProfitMinor,
        marginBps: marginBps(grossProfitMinor, netSalesMinor),
        averageBasketMinor: t?.salesCount ? Math.round(netSalesMinor / t.salesCount) : 0,
        prescriptionSales: t?.prescriptionSales ?? 0,
        prescriptionValueMinor: t?.prescriptionValueMinor ?? 0,
      },
      trend: trend.map((row) => ({
        date: row._id,
        salesCount: row.salesCount,
        netSalesMinor: row.netSalesMinor,
        grossProfitMinor: row.netSalesMinor - row.costMinor,
      })),
      // Line revenue and profit are before any sale-level discount.
      medicines: medicines.map((row) => ({
        medicineId: row._id,
        name: row.name,
        strength: row.strength,
        genericName: row.genericName,
        quantity: row.quantity,
        revenueMinor: row.revenueMinor,
        costMinor: row.costMinor,
        profitMinor: row.revenueMinor - row.costMinor,
        marginBps: marginBps(row.revenueMinor - row.costMinor, row.revenueMinor),
      })),
      dosageForms: dosageForms.map((row) => ({ dosageForm: row._id || 'other', quantity: row.quantity, revenueMinor: row.revenueMinor })),
      // Cash change handed back is not money kept.
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
      writeOffs: {
        units: writeOffs.reduce((sum, row) => sum + row.units, 0),
        costMinor: writeOffs.reduce((sum, row) => sum + row.costMinor, 0),
        byMedicine: writeOffs.slice(0, 10).map((row) => ({ medicineId: row._id, name: row.name, units: row.units, costMinor: row.costMinor })),
      },
      expiry: { expired: bucket('expired'), within30: bucket('within30'), within60: bucket('within60'), within90: bucket('within90') },
      slowMovers: slowMovers.map((row) => ({
        medicineId: row._id,
        name: row.name ?? 'Removed medicine',
        strength: row.strength ?? '',
        units: row.units,
        stockCostMinor: row.stockCostMinor,
      })),
    };
  }
}

export const pharmacyReportsService = new PharmacyReportsService();
