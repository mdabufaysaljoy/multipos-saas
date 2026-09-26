import { Types } from 'mongoose';
import { ShopProductModel } from '../../../models/ShopProduct';
import { ShopStockModel, type ShopStockDoc } from '../../../models/ShopStock';
import { ShopStockMovementModel, type ShopMovementType } from '../../../models/ShopStockMovement';
import { describeQuantity } from '../../../models/shopUnits';
import { ApiError } from '../../../utils/ApiError';
import type { TenantContext } from '../../../types/express';
import type { InventoryAdapter, Reservation, StockDescription, StockMoveRef, StockRequest } from '../adapter';

type StockRecord = ShopStockDoc & { _id: Types.ObjectId };

/** A unique-index violation, as MongoDB reports it. */
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;

/** What Super Shop needs back from a reservation to cost the sale line. */
export interface ShopStockDetail {
  productName: string;
  unitType: string;
  /** Weighted average cost, per piece or per kilogram, at the moment it was taken. */
  costPriceMinor: number;
  /** True when the branch had none of this and sold it anyway. */
  outOfStockOverride?: boolean;
}

export type ShopReservation = Reservation<ShopStockDetail>;

/** One ledger row, in the shape `ShopStockMovement` stores. */
export function shopMovementRow(
  ctx: TenantContext,
  product: { _id: Types.ObjectId; name: string; unitType: string },
  type: ShopMovementType,
  quantity: number,
  balanceAfter: number,
  extra: { reason?: string; referenceId?: Types.ObjectId | null; referenceNumber?: string; unitCostMinor?: number; outOfStockOverride?: boolean } = {},
) {
  return {
    tenantId: ctx.tenantId,
    storeId: ctx.storeId,
    productId: product._id,
    productNameSnapshot: product.name,
    unitType: product.unitType,
    type,
    quantity,
    balanceAfter,
    unitCostMinor: extra.unitCostMinor ?? null,
    reason: extra.reason ?? '',
    referenceId: extra.referenceId ?? null,
    referenceNumber: extra.referenceNumber ?? '',
    createdBy: ctx.userId,
    createdByNameSnapshot: ctx.userName,
    ...(extra.outOfStockOverride ? { outOfStockOverride: true } : {}),
  };
}

/**
 * Super Shop stock: one row per product per branch, never negative.
 *
 * Every take is a single guarded `$inc`, so two tills selling the last packet
 * cannot both succeed - the loser matches no document and is told what is
 * actually on the shelf.
 */
class SupershopInventoryAdapter implements InventoryAdapter<ShopStockDetail> {
  readonly vertical = 'supershop' as const;
  readonly tracksStock = true;

  async reserve(ctx: TenantContext, request: StockRequest): Promise<ShopReservation> {
    const updated = await ShopStockModel.findOneAndUpdate(
      { tenantId: ctx.tenantId, storeId: ctx.storeId, productId: request.itemId, quantityOnHand: { $gte: request.quantity } },
      { $inc: { quantityOnHand: -request.quantity } },
      { new: true },
    ).lean<StockRecord>();
    if (updated) {
      return {
        itemId: request.itemId,
        quantity: request.quantity,
        balanceAfter: updated.quantityOnHand,
        detail: { productName: request.label, unitType: '', costPriceMinor: updated.costPriceMinor },
      };
    }

    // The same override Clothing has always had: a till that holds the
    // permission may sell goods the system thinks are gone, and only then. A
    // product that still has SOME stock but not enough is refused as before -
    // this overrides "out of stock", not "not enough stock".
    //
    // `upsert` is what makes it work for a product that was never received into
    // this branch. Such a product has NO stock row at all - the common case for
    // a bulk import with no opening-stock column, and equally for a product
    // added by hand and not yet delivered - and an update alone matched nothing,
    // so the override silently did not apply to exactly the goods it was meant
    // for. The insert starts the row at the negative balance the sale creates,
    // which is the same state an existing row would have reached.
    //
    // A row that exists with SOME stock (more than zero, fewer than asked for)
    // does not match `$lte: 0`, so the upsert tries to insert a second row for
    // the same product and the unique index refuses it. That duplicate key is
    // the "not enough stock" case, and it falls through to the error below.
    if (request.allowOutOfStock) {
      try {
        const sold = await ShopStockModel.findOneAndUpdate(
          { tenantId: ctx.tenantId, storeId: ctx.storeId, productId: request.itemId, quantityOnHand: { $lte: 0 } },
          {
            $inc: { quantityOnHand: -request.quantity },
            // A branch that never received these goods has no cost basis for
            // them. Zero is recorded rather than guessed, so the first delivery
            // sets the real average; the sale's own cost is zero and the ledger
            // row is stamped `outOfStockOverride`, which is what a report needs
            // to explain the margin.
            $setOnInsert: { costPriceMinor: 0, lastReceivedAt: null },
          },
          { new: true, upsert: true },
        ).lean<StockRecord>();
        if (sold) {
          return {
            itemId: request.itemId,
            quantity: request.quantity,
            balanceAfter: sold.quantityOnHand,
            detail: { productName: request.label, unitType: '', costPriceMinor: sold.costPriceMinor, outOfStockOverride: true },
          };
        }
      } catch (error) {
        // Not an out-of-stock sale after all: there is stock, just not enough.
        if (!isDuplicateKey(error)) throw error;
      }
    }

    const product = await ShopProductModel.findOne({ _id: request.itemId, tenantId: ctx.tenantId }).select('unitType').lean();
    const stock = await ShopStockModel.findOne({ tenantId: ctx.tenantId, storeId: ctx.storeId, productId: request.itemId }).select('quantityOnHand').lean();
    // Either the branch holds some but not enough, or the till may not sell
    // past zero. A product never received here reads as 0, which is true.
    throw ApiError.badRequest(
      `Only ${describeQuantity(stock?.quantityOnHand ?? 0, product?.unitType ?? 'each')} of ${request.label} is in stock in this branch.`,
      { productId: request.itemId, available: stock?.quantityOnHand ?? 0 },
    );
  }

  /** A sale that never happened leaves no trace: stock back, no ledger row. */
  async release(ctx: TenantContext, reservations: ShopReservation[]): Promise<void> {
    await Promise.all(
      reservations.map((entry) =>
        ShopStockModel.updateOne({ tenantId: ctx.tenantId, storeId: ctx.storeId, productId: entry.itemId }, { $inc: { quantityOnHand: entry.quantity } }),
      ),
    );
    reservations.length = 0;
  }

  async commit(ctx: TenantContext, reservations: ShopReservation[], ref: StockMoveRef): Promise<void> {
    if (reservations.length === 0) return;
    await ShopStockMovementModel.insertMany(
      reservations.map((entry) =>
        shopMovementRow(
          ctx,
          { _id: entry.itemId, name: entry.detail.productName, unitType: entry.detail.unitType },
          'sale',
          -entry.quantity,
          entry.balanceAfter,
          {
            reason: entry.detail.outOfStockOverride ? `${ref.reason ?? 'Sale'} (out-of-stock sale)` : ref.reason,
            referenceId: ref.referenceId,
            referenceNumber: ref.referenceNumber,
            outOfStockOverride: entry.detail.outOfStockOverride,
          },
        ),
      ),
    );
  }

  /** A completed sale coming back: stock returns AND the branch sees it. */
  async restore(ctx: TenantContext, reservations: ShopReservation[], ref: StockMoveRef): Promise<void> {
    const movements = [];
    for (const entry of reservations) {
      const stock = await ShopStockModel.findOneAndUpdate(
        { tenantId: ctx.tenantId, storeId: ctx.storeId, productId: entry.itemId },
        { $inc: { quantityOnHand: entry.quantity } },
        { new: true },
      ).lean<StockRecord>();
      if (!stock) continue;
      movements.push(
        shopMovementRow(ctx, { _id: entry.itemId, name: entry.detail.productName, unitType: entry.detail.unitType }, 'void', entry.quantity, stock.quantityOnHand, {
          reason: ref.reason,
          referenceId: ref.referenceId,
          referenceNumber: ref.referenceNumber,
        }),
      );
    }
    if (movements.length > 0) await ShopStockMovementModel.insertMany(movements);
  }

  async describe(ctx: TenantContext, itemId: Types.ObjectId): Promise<StockDescription | null> {
    const product = await ShopProductModel.findOne({ _id: itemId, tenantId: ctx.tenantId, deletedAt: null }).select('name').lean();
    if (!product) return null;
    const stock = await ShopStockModel.findOne({ tenantId: ctx.tenantId, storeId: ctx.storeId, productId: itemId }).select('quantityOnHand').lean();
    return { itemId, label: product.name, onHand: stock?.quantityOnHand ?? 0 };
  }
}

export const supershopInventoryAdapter = new SupershopInventoryAdapter();
