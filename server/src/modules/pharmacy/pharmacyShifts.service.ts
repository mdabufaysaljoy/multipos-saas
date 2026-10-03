import type { Types } from 'mongoose';
import { PharmacySaleModel } from '../../models/PharmacySale';
import { PharmacyShiftModel, type PharmacyShiftDoc } from '../../models/PharmacyShift';
import { ReturnModel } from '../../models/Return';
import { StoreModel } from '../../models/Store';
import type { TenantContext } from '../../types/express';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import { resolvePage } from '../../utils/pagination';
import type { CashMovementInput, CloseShiftInput, ListShiftsInput, OpenShiftInput } from './pharmacy.validators';

type ShiftRecord = PharmacyShiftDoc & { _id: Types.ObjectId };
const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

/** Pharmacy-only cash drawer and immutable X/Z reporting. */
class PharmacyShiftsService {
  async current(ctx: TenantContext) {
    const shift = await PharmacyShiftModel.findOne({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      status: 'open',
    }).lean<ShiftRecord>();
    return shift ? this.present(ctx, shift) : null;
  }

  async open(ctx: TenantContext, input: OpenShiftInput) {
    if (await PharmacyShiftModel.exists({ tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'open' })) {
      throw ApiError.conflict('A shift is already open in this branch. Close it first.');
    }
    const seq = await nextSequence(ctx.tenantId, ctx.storeId, 'pharmacy-shift');
    try {
      const shift = await PharmacyShiftModel.create({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        shiftNumber: formatDocumentNumber('RX-SHIFT-', seq),
        openingFloatMinor: input.openingFloatMinor,
        openingNote: input.note,
        openedAt: new Date(),
        openedBy: ctx.userId,
        openedByNameSnapshot: ctx.userName,
      });
      return this.present(ctx, shift.toObject() as ShiftRecord);
    } catch (error) {
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
        throw ApiError.badRequest('The drawer should not hold that much cash', {
          expectedCashMinor: report.cash.expectedCashMinor,
        });
      }
    }
    const updated = await PharmacyShiftModel.findOneAndUpdate(
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

  async close(ctx: TenantContext, id: Types.ObjectId, input: CloseShiftInput) {
    const closedAt = new Date();
    const closed = await PharmacyShiftModel.findOneAndUpdate(
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
    const frozen = { ...report, cash: { ...report.cash, countedCashMinor: input.countedCashMinor, varianceMinor } };
    const final = await PharmacyShiftModel.findOneAndUpdate(
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
      PharmacyShiftModel.find(filter)
        .sort({ openedAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-report -cashMovements')
        .lean(),
      PharmacyShiftModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  async get(ctx: TenantContext, id: Types.ObjectId) {
    return this.present(ctx, await this.find(ctx, id));
  }

  private async find(ctx: TenantContext, id: Types.ObjectId) {
    const shift = await PharmacyShiftModel.findOne({
      _id: id,
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
    }).lean<ShiftRecord>();
    if (!shift) throw ApiError.notFound('Shift not found');
    return shift;
  }

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

  private async buildReport(shift: ShiftRecord, until: Date) {
    const scope = { tenantId: shift.tenantId, storeId: shift.storeId };
    const completed = { ...scope, shiftId: shift._id, status: 'completed' };
    const returnedAt = { $gte: shift.openedAt, $lte: until };
    const [totalRows, byMethod, voidRows, returnRows, cashReturnRows] = await Promise.all([
      PharmacySaleModel.aggregate<{
        sales: number;
        grossSalesMinor: number;
        discountsMinor: number;
        netSalesMinor: number;
        changeMinor: number;
        itemsSold: number;
      }>([
        { $match: completed },
        {
          $group: {
            _id: null,
            sales: { $sum: 1 },
            grossSalesMinor: { $sum: '$subtotalMinor' },
            discountsMinor: { $sum: '$discountMinor' },
            netSalesMinor: { $sum: '$totalMinor' },
            changeMinor: { $sum: '$changeMinor' },
            itemsSold: { $sum: { $sum: '$items.quantity' } },
          },
        },
      ]),
      PharmacySaleModel.aggregate<{ _id: string; amountMinor: number; count: number }>([
        { $match: completed },
        { $unwind: '$payments' },
        { $group: { _id: '$payments.method', amountMinor: { $sum: '$payments.amountMinor' }, count: { $sum: 1 } } },
      ]),
      PharmacySaleModel.aggregate<{ sales: number; valueMinor: number }>([
        { $match: { ...scope, shiftId: shift._id, status: 'voided' } },
        { $group: { _id: null, sales: { $sum: 1 }, valueMinor: { $sum: '$totalMinor' } } },
      ]),
      ReturnModel.aggregate<{ returns: number; amountMinor: number }>([
        { $match: { ...scope, vertical: 'pharmacy', returnedAt } },
        { $group: { _id: null, returns: { $sum: 1 }, amountMinor: { $sum: '$totalMinor' } } },
      ]),
      ReturnModel.aggregate<{ amountMinor: number }>([
        { $match: { ...scope, vertical: 'pharmacy', refundMethod: 'cash', exchange: null, returnedAt } },
        { $group: { _id: null, amountMinor: { $sum: '$totalMinor' } } },
      ]),
    ]);

    const totals = totalRows[0];
    const changeMinor = totals?.changeMinor ?? 0;
    const cashSalesMinor = (byMethod.find((row) => row._id === 'cash')?.amountMinor ?? 0) - changeMinor;
    const cashRefundsMinor = cashReturnRows[0]?.amountMinor ?? 0;
    const payInsMinor = shift.cashMovements
      .filter((row) => row.type === 'pay_in')
      .reduce((sum, row) => sum + row.amountMinor, 0);
    const payOutsMinor = shift.cashMovements
      .filter((row) => row.type === 'pay_out')
      .reduce((sum, row) => sum + row.amountMinor, 0);
    return {
      generatedAt: until,
      sales: {
        salesCount: totals?.sales ?? 0,
        itemsSold: totals?.itemsSold ?? 0,
        grossSalesMinor: totals?.grossSalesMinor ?? 0,
        discountsMinor: totals?.discountsMinor ?? 0,
        netSalesMinor: totals?.netSalesMinor ?? 0,
      },
      byPaymentMethod: byMethod
        .map((row) => ({
          method: row._id,
          amountMinor: row._id === 'cash' ? row.amountMinor - changeMinor : row.amountMinor,
          count: row.count,
        }))
        .sort((a, b) => b.amountMinor - a.amountMinor),
      returns: {
        count: returnRows[0]?.returns ?? 0,
        amountMinor: returnRows[0]?.amountMinor ?? 0,
        cashMinor: cashRefundsMinor,
      },
      voids: { sales: voidRows[0]?.sales ?? 0, valueMinor: voidRows[0]?.valueMinor ?? 0 },
      cash: {
        openingFloatMinor: shift.openingFloatMinor,
        cashSalesMinor,
        cashRefundsMinor,
        payInsMinor,
        payOutsMinor,
        expectedCashMinor: shift.openingFloatMinor + cashSalesMinor - cashRefundsMinor + payInsMinor - payOutsMinor,
        countedCashMinor: null as number | null,
        varianceMinor: null as number | null,
      },
    };
  }
}

export const pharmacyShiftsService = new PharmacyShiftsService();
