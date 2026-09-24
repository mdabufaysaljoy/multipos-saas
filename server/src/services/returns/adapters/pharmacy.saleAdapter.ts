import type { Types } from 'mongoose';
import { PharmacySaleModel } from '../../../models/PharmacySale';
import type { TenantContext } from '../../../types/express';
import type { ReturnableSale, SaleReturnAdapter } from '../posReturns.types';

/**
 * A Pharmacy sale, as the return engine reads and holds it.
 *
 * Each line carries the batches it was dispensed from, so the engine can send
 * the units back to the batch they came out of - a pharmacy may not mix them.
 */
class PharmacySaleReturnAdapter implements SaleReturnAdapter {
  readonly vertical = 'pharmacy' as const;

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

  async applyReturnTotals(ctx: TenantContext, saleId: Types.ObjectId, refundedMinor: number): Promise<void> {
    await PharmacySaleModel.updateOne({ _id: saleId, tenantId: ctx.tenantId }, { $inc: { returnedTotalMinor: refundedMinor } });
    const sale = await PharmacySaleModel.findOne({ _id: saleId, tenantId: ctx.tenantId }).select('items').lean();
    const fully = (sale?.items ?? []).every((line) => (line.returnedQuantity ?? 0) >= line.quantity);
    await PharmacySaleModel.updateOne({ _id: saleId, tenantId: ctx.tenantId }, { $set: { fullyReturned: fully } });
  }
}

export const pharmacySaleReturnAdapter = new PharmacySaleReturnAdapter();
