import type { Types } from 'mongoose';
import { INVENTORY_TX_TYPES } from '../../../config/constants';
import { ProductVariantModel } from '../../../models/ProductVariant';
import type { TenantContext } from '../../../types/express';
import type { InventoryAdapter, Reservation, StockDescription, StockMoveRef, StockRequest } from '../adapter';
import { inventoryService, type StockMovementResult } from '../inventory.service';

/** Clothing's own movement record, which the sale keeps to flag its lines. */
export type ClothingReservation = Reservation<StockMovementResult>;

/**
 * Clothing stock: one number on the variant, and the only stock in the platform
 * that may go below zero - a till with `sales.sellOutOfStock` can sell an item
 * that is already at zero, and both the ledger row and the sale line say so.
 *
 * Unlike the other verticals this one writes its ledger row as the stock moves,
 * because the row is what carries the override flag. `commit` therefore stamps
 * the invoice number onto rows that already exist rather than writing new ones.
 */
class ClothingInventoryAdapter implements InventoryAdapter<StockMovementResult> {
  readonly vertical = 'clothing' as const;
  readonly tracksStock = true;

  async reserve(ctx: TenantContext, request: StockRequest): Promise<ClothingReservation> {
    const movement = await inventoryService.decreaseForSale(
      ctx,
      request.itemId,
      request.quantity,
      { type: INVENTORY_TX_TYPES.SALE, reason: 'POS sale', referenceType: 'sale' },
      { allowOutOfStock: request.allowOutOfStock ?? false },
    );
    return { itemId: request.itemId, quantity: request.quantity, balanceAfter: movement.newStock, detail: movement };
  }

  /** A sale that never happened: every decrement is put back, loudly if it fails. */
  async release(ctx: TenantContext, reservations: ClothingReservation[]): Promise<void> {
    await inventoryService.compensate(ctx, reservations.map((entry) => entry.detail), 'sale could not be completed');
    reservations.length = 0;
  }

  /** The rows are already written; this stamps them with the invoice number. */
  async commit(ctx: TenantContext, reservations: ClothingReservation[], ref: StockMoveRef): Promise<void> {
    if (!ref.referenceId || reservations.length === 0) return;
    await inventoryService.attachReference(ctx, reservations.map((entry) => entry.detail), 'sale', ref.referenceId, ref.referenceNumber ?? '');
  }

  async restore(ctx: TenantContext, reservations: ClothingReservation[], ref: StockMoveRef): Promise<void> {
    for (const entry of reservations) {
      await inventoryService.increase(ctx, entry.itemId, entry.quantity, {
        type: INVENTORY_TX_TYPES.RETURN,
        reason: ref.reason ?? 'Returned',
        referenceType: 'return',
        referenceId: ref.referenceId ?? null,
        referenceNumber: ref.referenceNumber,
      });
    }
  }

  async describe(ctx: TenantContext, itemId: Types.ObjectId): Promise<StockDescription | null> {
    const variant = await ProductVariantModel.findOne({ _id: itemId, tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null })
      .select('stock name productNameSnapshot')
      .lean();
    if (!variant) return null;
    return { itemId, label: `${variant.productNameSnapshot} (${variant.name})`, onHand: variant.stock };
  }
}

export const clothingInventoryAdapter = new ClothingInventoryAdapter();
