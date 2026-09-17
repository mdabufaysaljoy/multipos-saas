import type { Types } from 'mongoose';
import { RestaurantOrderModel } from '../../models/RestaurantOrder';
import { RestaurantShiftModel, type RestaurantShiftDoc } from '../../models/RestaurantShift';
import { StoreModel } from '../../models/Store';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import { resolvePage } from '../../utils/pagination';
import type { TenantContext } from '../../types/express';
import type { CashMovementInput, CloseShiftInput, ListShiftsInput, OpenShiftInput } from './restaurant.validators';

type ShiftRecord = RestaurantShiftDoc & { _id: Types.ObjectId };

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

/**
 * Cash-drawer shifts and their Z-reports for the Restaurant vertical.
 *
 * Every figure is aggregated from order snapshots (never current menu prices).
 * While a shift is open its report is live; closing freezes it on the shift.
 */
class ShiftService {
  /** The branch's open shift with its live report, or null. */
  async current(ctx: TenantContext) {
    const shift = await RestaurantShiftModel.findOne({ tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'open' }).lean<ShiftRecord>();
    return shift ? this.present(ctx, shift) : null;
  }

  async open(ctx: TenantContext, input: OpenShiftInput) {
    const existing = await RestaurantShiftModel.exists({ tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'open' });
    if (existing) throw ApiError.conflict('A shift is already open in this branch. Close it first.');

    const seq = await nextSequence(ctx.tenantId, ctx.storeId, 'restaurant-shift');
    try {
      const shift = await RestaurantShiftModel.create({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        shiftNumber: formatDocumentNumber('SHIFT-', seq),
        status: 'open',
        openingFloatMinor: input.openingFloatMinor,
        openingNote: input.note,
        openedAt: new Date(),
        openedBy: ctx.userId,
        openedByNameSnapshot: ctx.userName,
      });
      return this.present(ctx, shift.toObject() as ShiftRecord);
    } catch (error) {
      // Two cashiers opening at the same moment: the partial unique index decides.
      if (isDuplicateKey(error)) throw ApiError.conflict('A shift is already open in this branch. Close it first.');
      throw error;
    }
  }

  async addCashMovement(ctx: TenantContext, id: Types.ObjectId, input: CashMovementInput) {
    const shift = await this.find(ctx, id);
    if (shift.status !== 'open') throw ApiError.conflict('This shift is closed');

    if (input.type === 'pay_out') {
      const report = await this.buildReport(shift, new Date());
      if (input.amountMinor > report.cash.expectedCashMinor) {
        throw ApiError.badRequest('The drawer should not hold that much cash', { expectedCashMinor: report.cash.expectedCashMinor });
      }
    }

    const updated = await RestaurantShiftModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'open' },
      {
        $push: {
          cashMovements: {
            type: input.type,
            amountMinor: input.amountMinor,
            reason: input.reason,
            at: new Date(),
            by: ctx.userId,
            byNameSnapshot: ctx.userName,
          },
        },
      },
      { new: true },
    ).lean<ShiftRecord>();
    if (!updated) throw ApiError.conflict('This shift was closed');
    return this.present(ctx, updated);
  }

  /**
   * Closes the shift: flips it closed FIRST (so no further payment attaches to
   * it), then computes the Z-report up to that moment and freezes it with the
   * cash count and variance.
   */
  async close(ctx: TenantContext, id: Types.ObjectId, input: CloseShiftInput) {
    const closedAt = new Date();
    const closed = await RestaurantShiftModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'open' },
      {
        $set: {
          status: 'closed',
          closedAt,
          closedBy: ctx.userId,
          closedByNameSnapshot: ctx.userName,
          closingNote: input.note,
          countedCashMinor: input.countedCashMinor,
        },
      },
      { new: true },
    ).lean<ShiftRecord>();
    if (!closed) {
      await this.find(ctx, id);
      throw ApiError.conflict('This shift is already closed');
    }

    const report = await this.buildReport(closed, closedAt);
    const varianceMinor = input.countedCashMinor - report.cash.expectedCashMinor;
    const frozen = {
      ...report,
      cash: { ...report.cash, countedCashMinor: input.countedCashMinor, varianceMinor },
    };

    const final = await RestaurantShiftModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'closed', report: null },
      { $set: { expectedCashMinor: report.cash.expectedCashMinor, varianceMinor, report: frozen } },
      { new: true },
    ).lean<ShiftRecord>();
    return this.present(ctx, final ?? closed);
  }

  async list(ctx: TenantContext, input: ListShiftsInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, storeId: ctx.storeId };
    if (input.status) filter.status = input.status;
    const [items, total] = await Promise.all([
      RestaurantShiftModel.find(filter).sort({ openedAt: -1 }).skip(skip).limit(limit).select('-report -cashMovements').lean(),
      RestaurantShiftModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  async get(ctx: TenantContext, id: Types.ObjectId) {
    return this.present(ctx, await this.find(ctx, id));
  }

  // ----------------------------------------------------------------------

  private async find(ctx: TenantContext, id: Types.ObjectId) {
    const shift = await RestaurantShiftModel.findOne({ _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId }).lean<ShiftRecord>();
    if (!shift) throw ApiError.notFound('Shift not found');
    return shift;
  }

  /** Shift + report (frozen once closed, live while open) + what printing needs. */
  private async present(ctx: TenantContext, shift: ShiftRecord) {
    const { report: frozen, ...rest } = shift;
    const [report, store] = await Promise.all([
      frozen ? Promise.resolve(frozen) : this.buildReport(shift, shift.closedAt ?? new Date()),
      StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId })
        .select('name logoUrl receiptLogoUrl phone email address currency receipt')
        .lean(),
    ]);
    return { shift: rest, report, store };
  }

  /** The Z-report for a shift, up to `until`. */
  private async buildReport(shift: ShiftRecord, until: Date) {
    const scope = { tenantId: shift.tenantId, storeId: shift.storeId };
    const window = { $gte: shift.openedAt, $lte: until };
    const paidMatch = { ...scope, shiftId: shift._id, status: 'paid' };

    const [totalsRows, byMethod, byType, cancelledRows, voidRows, openRows] = await Promise.all([
      RestaurantOrderModel.aggregate<{
        paidOrders: number;
        grossSalesMinor: number;
        discountsMinor: number;
        netSalesMinor: number;
        changeMinor: number;
        itemsSold: number;
      }>([
        { $match: paidMatch },
        {
          $group: {
            _id: null,
            paidOrders: { $sum: 1 },
            grossSalesMinor: { $sum: '$subtotalMinor' },
            discountsMinor: { $sum: '$discountMinor' },
            netSalesMinor: { $sum: '$totalMinor' },
            changeMinor: { $sum: '$changeMinor' },
            itemsSold: { $sum: { $sum: '$items.quantity' } },
          },
        },
      ]),
      RestaurantOrderModel.aggregate<{ _id: string; amountMinor: number; count: number }>([
        { $match: paidMatch },
        { $unwind: '$payments' },
        { $group: { _id: '$payments.method', amountMinor: { $sum: '$payments.amountMinor' }, count: { $sum: 1 } } },
      ]),
      RestaurantOrderModel.aggregate<{ _id: string; orders: number; netSalesMinor: number }>([
        { $match: paidMatch },
        { $group: { _id: '$type', orders: { $sum: 1 }, netSalesMinor: { $sum: '$totalMinor' } } },
      ]),
      RestaurantOrderModel.aggregate<{ orders: number; valueMinor: number }>([
        { $match: { ...scope, status: 'cancelled', cancelledAt: window } },
        { $group: { _id: null, orders: { $sum: 1 }, valueMinor: { $sum: '$subtotalMinor' } } },
      ]),
      RestaurantOrderModel.aggregate<{ lines: number; quantity: number; valueMinor: number }>([
        { $match: { ...scope, 'items.voidedAt': window } },
        { $unwind: '$items' },
        { $match: { 'items.voidedAt': window } },
        {
          $group: {
            _id: null,
            lines: { $sum: 1 },
            quantity: { $sum: '$items.sentQuantity' },
            valueMinor: { $sum: { $multiply: ['$items.sentQuantity', '$items.unitPriceMinor'] } },
          },
        },
      ]),
      RestaurantOrderModel.aggregate<{ orders: number; valueMinor: number }>([
        { $match: { ...scope, status: 'open' } },
        { $group: { _id: null, orders: { $sum: 1 }, valueMinor: { $sum: '$totalMinor' } } },
      ]),
    ]);

    const totals = totalsRows[0];
    const changeMinor = totals?.changeMinor ?? 0;
    const cashTakenMinor = byMethod.find((m) => m._id === 'cash')?.amountMinor ?? 0;
    const cashSalesMinor = cashTakenMinor - changeMinor;
    const payInsMinor = shift.cashMovements.filter((m) => m.type === 'pay_in').reduce((sum, m) => sum + m.amountMinor, 0);
    const payOutsMinor = shift.cashMovements.filter((m) => m.type === 'pay_out').reduce((sum, m) => sum + m.amountMinor, 0);

    return {
      generatedAt: until,
      sales: {
        paidOrders: totals?.paidOrders ?? 0,
        itemsSold: totals?.itemsSold ?? 0,
        grossSalesMinor: totals?.grossSalesMinor ?? 0,
        discountsMinor: totals?.discountsMinor ?? 0,
        netSalesMinor: totals?.netSalesMinor ?? 0,
      },
      // Cash net of change handed back, so the methods add up to net sales.
      byPaymentMethod: byMethod
        .map((m) => ({ method: m._id, amountMinor: m._id === 'cash' ? m.amountMinor - changeMinor : m.amountMinor, count: m.count }))
        .sort((a, b) => b.amountMinor - a.amountMinor),
      byType: (['dine_in', 'takeaway'] as const).map((type) => {
        const row = byType.find((t) => t._id === type);
        return { type, orders: row?.orders ?? 0, netSalesMinor: row?.netSalesMinor ?? 0 };
      }),
      cancelled: { orders: cancelledRows[0]?.orders ?? 0, valueMinor: cancelledRows[0]?.valueMinor ?? 0 },
      voids: { lines: voidRows[0]?.lines ?? 0, quantity: voidRows[0]?.quantity ?? 0, valueMinor: voidRows[0]?.valueMinor ?? 0 },
      openOrders: { orders: openRows[0]?.orders ?? 0, valueMinor: openRows[0]?.valueMinor ?? 0 },
      cash: {
        openingFloatMinor: shift.openingFloatMinor,
        cashSalesMinor,
        payInsMinor,
        payOutsMinor,
        expectedCashMinor: shift.openingFloatMinor + cashSalesMinor + payInsMinor - payOutsMinor,
        countedCashMinor: null as number | null,
        varianceMinor: null as number | null,
      },
    };
  }
}

export const shiftService = new ShiftService();
