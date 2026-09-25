import type { Types } from 'mongoose';
import { RestaurantOrderModel } from '../../../models/RestaurantOrder';
import type { TenantContext } from '../../../types/express';
import { loyaltyService } from '../../../modules/loyalty/loyalty.service';
import type { ReturnableSale, SaleReturnAdapter } from '../posReturns.types';

/**
 * A paid restaurant order, as the return engine reads and holds it.
 *
 * Nothing goes back on a shelf - the kitchen cooked it and it is gone - so a
 * restaurant return is money and a record, and the no-op inventory adapter is
 * what makes that come out right rather than a special case in the engine.
 *
 * Only a PAID order can be refunded. An open one is changed or cancelled
 * instead, which is a different thing and already exists.
 */
class RestaurantSaleReturnAdapter implements SaleReturnAdapter {
  readonly vertical = 'restaurant' as const;

  async findSale(ctx: TenantContext, saleId: Types.ObjectId): Promise<ReturnableSale | null> {
    const order = await RestaurantOrderModel.findOne({ _id: saleId, tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'paid' }).lean();
    if (!order) return null;
    return {
      saleId: order._id,
      saleNumber: order.orderNumber,
      subtotalMinor: order.subtotalMinor,
      discountMinor: order.discountMinor,
      customerId: order.customerId ?? null,
      customerName: order.customerNameSnapshot ?? '',
      customerPhone: '',
      // A voided line was never charged for, so there is nothing to give back.
      lines: order.items
        .filter((line) => !line.voidedAt && line.quantity > 0)
        .map((line) => ({
          saleItemId: line._id,
          itemId: line.menuItemId,
          label: line.nameSnapshot,
          detail: line.categorySnapshot,
          quantity: line.quantity,
          returnedQuantity: line.returnedQuantity ?? 0,
          unitPriceMinor: line.unitPriceMinor,
          // A kitchen has no cost per dish here, so a refund takes no cost back.
          costPriceMinor: 0,
        })),
    };
  }

  async reserve(ctx: TenantContext, saleId: Types.ObjectId, line: { saleItemId: Types.ObjectId; quantity: number; sold: number }): Promise<boolean> {
    const result = await RestaurantOrderModel.updateOne(
      {
        _id: saleId,
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        status: 'paid',
        items: { $elemMatch: { _id: line.saleItemId, returnedQuantity: { $lte: line.sold - line.quantity } } },
      },
      { $inc: { 'items.$.returnedQuantity': line.quantity } },
    );
    return result.matchedCount > 0;
  }

  async release(ctx: TenantContext, saleId: Types.ObjectId, lines: { saleItemId: Types.ObjectId; quantity: number }[]): Promise<void> {
    for (const line of lines) {
      await RestaurantOrderModel.updateOne(
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
    const sale = await RestaurantOrderModel.findOne({ _id: saleId, tenantId: ctx.tenantId }).select('loyalty orderNumber').lean();
    if (!sale?.loyalty) return;
    const claim = await loyaltyService.claimReturn(ctx, saleId, RestaurantOrderModel as never);
    if (!claim) return;
    await loyaltyService.applyReturnClaim(ctx, claim, {
      key: `return:${saleId}:${claim.pointsEarnedReversed}:${claim.pointsRedeemedRestored}`,
      saleId,
      saleNumber: sale.orderNumber,
      reason: reason || 'Refund',
    });
  }

  async applyReturnTotals(ctx: TenantContext, saleId: Types.ObjectId, refundedMinor: number): Promise<void> {
    await RestaurantOrderModel.updateOne({ _id: saleId, tenantId: ctx.tenantId }, { $inc: { returnedTotalMinor: refundedMinor } });
    const order = await RestaurantOrderModel.findOne({ _id: saleId, tenantId: ctx.tenantId }).select('items').lean();
    const fully = (order?.items ?? [])
      .filter((line) => !line.voidedAt && line.quantity > 0)
      .every((line) => (line.returnedQuantity ?? 0) >= line.quantity);
    await RestaurantOrderModel.updateOne({ _id: saleId, tenantId: ctx.tenantId }, { $set: { fullyReturned: fully } });
  }
}

export const restaurantSaleReturnAdapter = new RestaurantSaleReturnAdapter();
