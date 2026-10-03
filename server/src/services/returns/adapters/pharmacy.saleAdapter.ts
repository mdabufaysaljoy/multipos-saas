import type { Types } from 'mongoose';
import { PharmacySaleModel } from '../../../models/PharmacySale';
import { MedicineModel } from '../../../models/Medicine';
import type { TenantContext } from '../../../types/express';
import { loyaltyService } from '../../../modules/loyalty/loyalty.service';
import { pharmacyService } from '../../../modules/pharmacy/pharmacy.service';
import { ApiError } from '../../../utils/ApiError';
import type { ExchangeQuote, ReplacementSale, ReturnableSale, SaleExchangeAdapter, SaleReturnAdapter } from '../posReturns.types';

/** Replacement medicines use the ordinary Pharmacy checkout and FEFO batches. */
class PharmacyExchangeAdapter implements SaleExchangeAdapter {
  async quote(ctx: TenantContext, items: { itemId: Types.ObjectId; quantity: number }[]): Promise<ExchangeQuote> {
    if (items.length === 0) throw ApiError.validation('Choose the replacement medicine');
    const medicines = await MedicineModel.find({ _id: { $in: items.map((item) => item.itemId) }, tenantId: ctx.tenantId, deletedAt: null }).lean();
    const lines = items.map((item) => {
      const medicine = medicines.find((entry) => entry._id.equals(item.itemId));
      if (!medicine) throw ApiError.badRequest('One of the replacement medicines is not in this pharmacy');
      if (!medicine.isActive) throw ApiError.badRequest(`${medicine.name} is not for sale right now`);
      const lineTotalMinor = medicine.sellingPriceMinor * item.quantity;
      if (!Number.isSafeInteger(lineTotalMinor)) throw ApiError.badRequest('That replacement line is too large');
      return { itemId: medicine._id, label: medicine.name, detail: `${medicine.strength} · ${medicine.dosageForm}`, quantity: item.quantity, unitPriceMinor: medicine.sellingPriceMinor, lineTotalMinor };
    });
    const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    return { subtotalMinor, totalMinor: subtotalMinor, lines };
  }

  async create(ctx: TenantContext, input: Parameters<SaleExchangeAdapter['create']>[1]): Promise<ReplacementSale> {
    const original = await PharmacySaleModel.findOne({ _id: input.originalSaleId, tenantId: ctx.tenantId, storeId: ctx.storeId }).select('prescription').lean();
    const sale = await pharmacyService.createSale(
      ctx,
      {
        items: input.items.map((item) => ({ medicineId: item.itemId, quantity: item.quantity })),
        payments: input.payments,
        discountMinor: 0,
        ...(input.customerId ? { customerId: input.customerId } : {}),
        ...(original?.prescription ? { prescription: original.prescription } : {}),
        redeemPoints: 0,
        note: input.note,
      } as never,
      { exchange: { originalSaleId: input.originalSaleId, originalSaleNumber: input.originalSaleNumber, creditMinor: input.creditMinor, returnedItems: input.returnedItems } },
    );
    return { saleId: sale._id, saleNumber: sale.saleNumber, subtotalMinor: sale.subtotalMinor, totalMinor: sale.totalMinor, paidMinor: sale.paidMinor, changeMinor: sale.changeMinor };
  }

  async cancel(ctx: TenantContext, saleId: Types.ObjectId, reason: string): Promise<void> {
    await pharmacyService.voidSale(ctx, saleId, reason);
  }

  async link(ctx: TenantContext, saleId: Types.ObjectId, returnId: Types.ObjectId, returnNumber: string): Promise<void> {
    await PharmacySaleModel.updateOne({ _id: saleId, tenantId: ctx.tenantId, storeId: ctx.storeId }, { $set: { 'exchange.returnId': returnId, 'exchange.returnNumber': returnNumber } });
  }
}

/**
 * A Pharmacy sale, as the return engine reads and holds it.
 *
 * Each line carries the batches it was dispensed from, so the engine can send
 * the units back to the batch they came out of - a pharmacy may not mix them.
 */
class PharmacySaleReturnAdapter implements SaleReturnAdapter {
  readonly vertical = 'pharmacy' as const;
  readonly exchangeRequiresPermissions = false;
  readonly exchange = new PharmacyExchangeAdapter();

  async findSale(ctx: TenantContext, saleId: Types.ObjectId): Promise<ReturnableSale | null> {
    const sale = await PharmacySaleModel.findOne({ _id: saleId, tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'completed' }).lean();
    if (!sale) return null;
    return {
      saleId: sale._id,
      saleNumber: sale.saleNumber,
      subtotalMinor: sale.subtotalMinor,
      discountMinor: sale.discountMinor,
      customerId: sale.customerId ?? null,
      customerName: sale.customerNameSnapshot ?? '',
      customerPhone: '',
      lines: sale.items.map((line) => ({
        saleItemId: line._id,
        itemId: line.medicineId,
        label: `${line.nameSnapshot} ${line.strengthSnapshot}`.trim(),
        detail: line.allocations[0] ? `Batch ${line.allocations[0].batchNumber}` : '',
        quantity: line.quantity,
        returnedQuantity: line.returnedQuantity ?? 0,
        unitPriceMinor: line.unitPriceMinor,
        costPriceMinor: line.allocations[0]?.costPriceMinor ?? 0,
        allocations: line.allocations.map((allocation) => ({
          batchId: allocation.batchId,
          batchNumber: allocation.batchNumber,
          quantity: allocation.quantity,
          costPriceMinor: allocation.costPriceMinor,
        })),
      })),
    };
  }

  async reserve(ctx: TenantContext, saleId: Types.ObjectId, line: { saleItemId: Types.ObjectId; quantity: number; sold: number }): Promise<boolean> {
    const result = await PharmacySaleModel.updateOne(
      {
        _id: saleId,
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        items: { $elemMatch: { _id: line.saleItemId, returnedQuantity: { $lte: line.sold - line.quantity } } },
      },
      { $inc: { 'items.$.returnedQuantity': line.quantity } },
    );
    return result.matchedCount > 0;
  }

  async release(ctx: TenantContext, saleId: Types.ObjectId, lines: { saleItemId: Types.ObjectId; quantity: number }[]): Promise<void> {
    for (const line of lines) {
      await PharmacySaleModel.updateOne(
        { _id: saleId, tenantId: ctx.tenantId, storeId: ctx.storeId, 'items._id': line.saleItemId },
        { $inc: { 'items.$.returnedQuantity': -line.quantity } },
      );
    }
  }


  /**
   * Points follow the goods. The claim is worked out from what has been
   * returned SO FAR, so a sale returned in several parts ends exactly where one
   * full return would - the shared loyalty maths does that part.
   */
  async reverseLoyalty(ctx: TenantContext, saleId: Types.ObjectId, reason: string): Promise<void> {
    const sale = await PharmacySaleModel.findOne({ _id: saleId, tenantId: ctx.tenantId }).select('loyalty saleNumber').lean();
    if (!sale?.loyalty) return;
    const claim = await loyaltyService.claimReturn(ctx, saleId, PharmacySaleModel as never);
    if (!claim) return;
    await loyaltyService.applyReturnClaim(ctx, claim, {
      key: `return:${saleId}:${claim.pointsEarnedReversed}:${claim.pointsRedeemedRestored}`,
      saleId,
      saleNumber: sale.saleNumber,
      reason: reason || 'Customer return',
    });
  }

  async applyReturnTotals(ctx: TenantContext, saleId: Types.ObjectId, refundedMinor: number): Promise<void> {
    await PharmacySaleModel.updateOne({ _id: saleId, tenantId: ctx.tenantId }, { $inc: { returnedTotalMinor: refundedMinor } });
    const sale = await PharmacySaleModel.findOne({ _id: saleId, tenantId: ctx.tenantId }).select('items').lean();
    const fully = (sale?.items ?? []).every((line) => (line.returnedQuantity ?? 0) >= line.quantity);
    await PharmacySaleModel.updateOne({ _id: saleId, tenantId: ctx.tenantId }, { $set: { fullyReturned: fully } });
  }
}

export const pharmacySaleReturnAdapter = new PharmacySaleReturnAdapter();
