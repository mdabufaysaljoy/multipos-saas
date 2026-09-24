import type { Types } from 'mongoose';
import type { PosVertical } from '../../config/verticals';
import type { TenantContext } from '../../types/express';

/**
 * What a sale line asks of stock, in the only terms shared code may use: an id
 * and a quantity. Never a model, and never another vertical's document.
 */
export interface StockRequest {
  /** The variant, product or medicine the line sells. */
  itemId: Types.ObjectId;
  /** Positive, in the item's own base unit - pieces for most, grams for weighed goods. */
  quantity: number;
  /** For the ledger row and any error message. */
  label: string;
  /**
   * Whether this till may sell an item that is already at zero. Decided by the
   * CALLER from the permissions resolved for this request, never from anything
   * the client sends. Only Clothing acts on it today; giving the other three
   * the same override is task 07, and a pharmacy will still refuse expired
   * stock whatever this says.
   */
  allowOutOfStock?: boolean;
}

/**
 * What was actually taken, and what it takes to put it back.
 *
 * `detail` is the vertical's own business: Pharmacy puts the batches it drew
 * from there (with their cost and expiry), Super Shop the average cost of what
 * it took. Shared code reads the four common fields and leaves `detail` alone;
 * the vertical that created it is the only thing that types it.
 */
export interface Reservation<TDetail = unknown> {
  itemId: Types.ObjectId;
  quantity: number;
  /** Stock left after this reservation, for the ledger. */
  balanceAfter: number;
  detail: TDetail;
}

/** Why stock moved, for the ledger row. */
export interface StockMoveRef {
  reason?: string;
  referenceId?: Types.ObjectId | null;
  referenceNumber?: string;
}

/** What a vertical can say about an item without exposing its model. */
export interface StockDescription {
  itemId: Types.ObjectId;
  label: string;
  /** Sellable now, in the item's base unit. Null where the vertical keeps no stock. */
  onHand: number | null;
}

/**
 * The seam between shared POS logic and each vertical's stock.
 *
 * Clothing keeps stock on the variant and may go below zero with the right
 * permission; Pharmacy holds it in batches and sells the earliest expiry first,
 * never expired, never negative; Super Shop keeps one row per product per
 * branch, never negative; a Restaurant has no stock at all. Those differences
 * are real and stay - what is shared is only the question being asked.
 *
 * `reserve` takes stock for a sale in progress. `release` puts back exactly
 * what a reservation took, for a sale that never completed - it writes no
 * ledger row, because as far as the branch is concerned nothing happened.
 * `restore` puts stock back after a sale that DID complete (a void, a return)
 * and does write one, because that is a real movement the branch must see.
 */
export interface InventoryAdapter<TDetail = unknown> {
  readonly vertical: PosVertical;
  /** True where the vertical keeps stock at all; false for Restaurant. */
  readonly tracksStock: boolean;

  reserve(ctx: TenantContext, request: StockRequest): Promise<Reservation<TDetail>>;
  release(ctx: TenantContext, reservations: Reservation<TDetail>[]): Promise<void>;
  restore(ctx: TenantContext, reservations: Reservation<TDetail>[], ref: StockMoveRef): Promise<void>;
  /** Records the sale movements for reservations that became a completed sale. */
  commit(ctx: TenantContext, reservations: Reservation<TDetail>[], ref: StockMoveRef): Promise<void>;
  describe(ctx: TenantContext, itemId: Types.ObjectId): Promise<StockDescription | null>;
}
