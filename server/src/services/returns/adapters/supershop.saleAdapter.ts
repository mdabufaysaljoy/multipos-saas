import { Types } from 'mongoose';
import { ShopProductModel } from '../../../models/ShopProduct';
import { ShopSaleModel } from '../../../models/ShopSale';
import { lineAmount } from '../../../models/shopUnits';
import { ApiError } from '../../../utils/ApiError';
import type { TenantContext } from '../../../types/express';
import { loyaltyService } from '../../../modules/loyalty/loyalty.service';
import { supershopService } from '../../../modules/supershop/supershop.service';
import type { ExchangeQuote, ReplacementSale, ReturnableSale, SaleExchangeAdapter, SaleReturnAdapter } from '../posReturns.types';

/**
 * What a Super Shop can do that a restaurant and a pharmacy cannot: swap goods.
 *
 * The replacement is an ordinary Super Shop sale - it is priced from the
 * catalogue, takes its own stock through the inventory adapter, writes its own
 * ledger rows and settles through the same tender rules - carrying a credit for
 * what came back. Nothing here re-implements a checkout.
 */
class SupershopExchangeAdapter implements SaleExchangeAdapter {
  async quote(ctx: TenantContext, items: { itemId: Types.ObjectId; quantity: number }[]): Promise<ExchangeQuote> {
    if (items.length === 0) throw ApiError.validation('Choose the replacement goods');
    const products = await ShopProductModel.find({
      _id: { $in: items.map((item) => item.itemId) },
      tenantId: ctx.tenantId,
      deletedAt: null,
    }).lean();

    const lines = items.map((item) => {
      const product = products.find((entry) => entry._id.equals(item.itemId));
      if (!product) throw ApiError.badRequest('One of the replacement items is not in this shop');
      if (!product.isActive) throw ApiError.badRequest(`${product.name} is not for sale right now`);
      const lineTotalMinor = lineAmount(product.priceMinor, item.quantity, product.unitType);
      if (!Number.isSafeInteger(lineTotalMinor)) throw ApiError.badRequest('That replacement line is too large');
      return {
        itemId: product._id,
        label: product.name,
        detail: product.unitType === 'weight' ? 'by weight' : 'by piece',
        quantity: item.quantity,
        unitPriceMinor: product.priceMinor,
        lineTotalMinor,
      };
    });

    // Super Shop prices include VAT and an exchange takes no discount, so the
    // basket total is its subtotal.
    const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    return { subtotalMinor, totalMinor: subtotalMinor, lines };
  }

  async create(
    ctx: TenantContext,
    input: {
      items: { itemId: Types.ObjectId; quantity: number }[];
      payments: { method: string; amountMinor: number }[];
      customerId: Types.ObjectId | null;
      creditMinor: number;
      originalSaleId: Types.ObjectId;
      originalSaleNumber: string;
      returnedItems: { nameSnapshot: string; detailSnapshot: string; quantity: number; unitType: string; lineTotalMinor: number }[];
      note: string;
    },
  ): Promise<ReplacementSale> {
    const sale = await supershopService.createSale(
      ctx,
      {
        items: input.items.map((item) => ({ productId: item.itemId, quantity: item.quantity })),
        payments: input.payments,
        discountMinor: 0,
        ...(input.customerId ? { customerId: input.customerId } : {}),
        redeemPoints: 0,
        note: input.note,
      } as never,
      {
        exchange: {
          originalSaleId: input.originalSaleId,
          originalSaleNumber: input.originalSaleNumber,
          creditMinor: input.creditMinor,
          returnedItems: input.returnedItems,
        },
      },
    );
    return {
      saleId: sale._id,
      saleNumber: sale.saleNumber,
      subtotalMinor: sale.subtotalMinor,
      totalMinor: sale.totalMinor,
      paidMinor: sale.paidMinor,
      changeMinor: sale.changeMinor,
    };
  }

  /** Voiding puts the replacement's stock back and writes the movement. */
  async cancel(ctx: TenantContext, saleId: Types.ObjectId, reason: string): Promise<void> {
    await supershopService.voidSale(ctx, saleId, reason);
  }

  async link(ctx: TenantContext, saleId: Types.ObjectId, returnId: Types.ObjectId, returnNumber: string): Promise<void> {
    await ShopSaleModel.updateOne(
      { _id: saleId, tenantId: ctx.tenantId, storeId: ctx.storeId },
      { $set: { 'exchange.returnId': returnId, 'exchange.returnNumber': returnNumber } },
    );
  }
}

/** A Super Shop sale, as the return engine reads and holds it. */
class SupershopSaleReturnAdapter implements SaleReturnAdapter {
  readonly vertical = 'supershop' as const;
  readonly exchange = new SupershopExchangeAdapter();

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
        unitType: line.unitType,
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

  /**
   * Points follow the goods. The claim is worked out from what has been
   * returned SO FAR, so a sale returned in several parts ends exactly where one
   * full return would - the shared loyalty maths does that part.
   */
  /**
   * A weighed line's quantity is in GRAMS and its prices are per KILOGRAM, so
   * neither what it sold for nor what it cost is price times quantity. This is
   * the same `lineAmount` the checkout used to charge for it, so a refund can
   * never differ from what was taken.
   */
  amountOf(line: { unitPriceMinor: number; unitType?: 'each' | 'weight' }, quantity: number): number {
    return lineAmount(line.unitPriceMinor, quantity, line.unitType ?? 'each');
  }

  costOf(line: { costPriceMinor: number; unitType?: 'each' | 'weight' }, quantity: number): number {
    return lineAmount(line.costPriceMinor, quantity, line.unitType ?? 'each');
  }

  async reverseLoyalty(ctx: TenantContext, saleId: Types.ObjectId, reason: string): Promise<void> {
    const sale = await ShopSaleModel.findOne({ _id: saleId, tenantId: ctx.tenantId }).select('loyalty saleNumber').lean();
    if (!sale?.loyalty) return;
    const claim = await loyaltyService.claimReturn(ctx, saleId, ShopSaleModel as never);
    if (!claim) return;
    await loyaltyService.applyReturnClaim(ctx, claim, {
      key: `return:${saleId}:${claim.pointsEarnedReversed}:${claim.pointsRedeemedRestored}`,
      saleId,
      saleNumber: sale.saleNumber,
      reason: reason || 'Customer return',
    });
  }

  async applyReturnTotals(ctx: TenantContext, saleId: Types.ObjectId, refundedMinor: number): Promise<void> {
    await ShopSaleModel.updateOne({ _id: saleId, tenantId: ctx.tenantId }, { $inc: { returnedTotalMinor: refundedMinor } });
    const sale = await ShopSaleModel.findOne({ _id: saleId, tenantId: ctx.tenantId }).select('items').lean();
    const fully = (sale?.items ?? []).every((line) => (line.returnedQuantity ?? 0) >= line.quantity);
    await ShopSaleModel.updateOne({ _id: saleId, tenantId: ctx.tenantId }, { $set: { fullyReturned: fully } });
  }
}

export const supershopSaleReturnAdapter = new SupershopSaleReturnAdapter();
