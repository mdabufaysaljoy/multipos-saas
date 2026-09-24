import type { Types } from 'mongoose';
import type { TenantContext } from '../../../types/express';
import type { InventoryAdapter, Reservation, StockDescription, StockRequest } from '../adapter';

/**
 * A restaurant keeps no stock.
 *
 * A kitchen cooks to order from ingredients nobody counts per dish, so there is
 * nothing to reserve, put back or run out of. This adapter says exactly that,
 * so shared code can treat all four verticals alike without pretending a
 * restaurant has a shelf. Inventing one to satisfy the interface would be worse
 * than saying no.
 */
class RestaurantInventoryAdapter implements InventoryAdapter<null> {
  readonly vertical = 'restaurant' as const;
  readonly tracksStock = false;

  async reserve(_ctx: TenantContext, request: StockRequest): Promise<Reservation<null>> {
    return { itemId: request.itemId, quantity: request.quantity, balanceAfter: 0, detail: null };
  }

  async release(): Promise<void> {}
  async commit(): Promise<void> {}
  async restore(): Promise<void> {}

  async describe(_ctx: TenantContext, itemId: Types.ObjectId): Promise<StockDescription | null> {
    return { itemId, label: '', onHand: null };
  }
}

export const restaurantInventoryAdapter = new RestaurantInventoryAdapter();
