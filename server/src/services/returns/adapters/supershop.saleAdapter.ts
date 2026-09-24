import type { Types } from 'mongoose';
import { ShopSaleModel } from '../../../models/ShopSale';
import type { TenantContext } from '../../../types/express';
import type { ReturnableSale, SaleReturnAdapter } from '../posReturns.types';

/** A Super Shop sale, as the return engine reads and holds it. */
class SupershopSaleReturnAdapter implements SaleReturnAdapter {
  readonly vertical = 'supershop' as const;

  async findSale(ctx: TenantContext, saleId: Types.ObjectId): Promise<ReturnableSale | null> {
    const sale = await ShopSaleModel.findOne({ _id: saleId, tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'completed' }).lean();
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
        itemId: line.productId,
        label: line.nameSnapshot,
        detail: line.unitType === 'weight' ? 'by weight' : 'by piece',
        quantity: line.quantity,
        returnedQuantity: line.returnedQuantity ?? 0,
        unitPriceMinor: line.unitPriceMinor,
        // Cost per piece or per kilogram, as the sale recorded it.
        costPriceMinor: line.quantity > 0 ? Math.round((line.costMinor * (line.unitType === 'weight' ? 1000 : 1)) / line.quantity) : 0,
      })),
    };
  }

  async reserve(ctx: TenantContext, saleId: Types.ObjectId, line: { saleItemId: Types.ObjectId; quantity: number; sold: number }): Promise<boolean> {
    const result = await ShopSaleModel.updateOne(
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
      await ShopSaleModel.updateOne(
        { _id: saleId, tenantId: ctx.tenantId, storeId: ctx.storeId, 'items._id': line.saleItemId },
        { $inc: { 'items.$.returnedQuantity': -line.quantity } },
      );
    }
  }

  async applyReturnTotals(ctx: TenantContext, saleId: Types.ObjectId, refundedMinor: number): Promise<void> {
    await ShopSaleModel.updateOne({ _id: saleId, tenantId: ctx.tenantId }, { $inc: { returnedTotalMinor: refundedMinor } });
    const sale = await ShopSaleModel.findOne({ _id: saleId, tenantId: ctx.tenantId }).select('items').lean();
    const fully = (sale?.items ?? []).every((line) => (line.returnedQuantity ?? 0) >= line.quantity);
    await ShopSaleModel.updateOne({ _id: saleId, tenantId: ctx.tenantId }, { $set: { fullyReturned: fully } });
  }
}

export const supershopSaleReturnAdapter = new SupershopSaleReturnAdapter();
