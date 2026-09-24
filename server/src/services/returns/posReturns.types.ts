import type { Types } from 'mongoose';
import type { PosVertical } from '../../config/verticals';
import type { TenantContext } from '../../types/express';

/** A line of a completed sale, as the return engine sees it. */
export interface ReturnableLine {
  saleItemId: Types.ObjectId;
  /** The variant, product or medicine that was sold. */
  itemId: Types.ObjectId;
  /** How the till names it: "Napa 500mg", "Keya Soap". */
  label: string;
  /** The vertical's second line, printed on the return: a SKU, a batch, a unit. */
  detail: string;
  quantity: number;
  returnedQuantity: number;
  /** Always the price from the original sale, never today's. */
  unitPriceMinor: number;
  /** Carried from the sale so returned goods take their cost out of profit too. */
  costPriceMinor: number;
  /** A pharmacy line names the batches it was dispensed from. */
  allocations?: { batchId: Types.ObjectId; batchNumber: string; quantity: number; costPriceMinor: number }[];
}

/** The sale a return is made against. */
export interface ReturnableSale {
  saleId: Types.ObjectId;
  saleNumber: string;
  /** What the goods came to before any sale-level discount. */
  subtotalMinor: number;
  /** A discount taken off the whole sale, which a refund has to share out. */
  discountMinor: number;
  customerId: Types.ObjectId | null;
  customerName: string;
  customerPhone: string;
  lines: ReturnableLine[];
}

/** What the engine was asked to bring back. */
export interface RequestedReturnLine {
  saleItemId: Types.ObjectId;
  quantity: number;
  /** False leaves the goods out of stock: damaged, expired, opened. */
  restock: boolean;
}

/**
 * How a vertical's sale answers the engine.
 *
 * The engine never touches a sale model: it asks the adapter what can come
 * back, to hold a quantity while the return is written, and to record the
 * result. Stock is a separate question, asked of the inventory adapter.
 */
export interface SaleReturnAdapter {
  readonly vertical: PosVertical;
  /** The sale, or null when it is not this branch's, not completed, or gone. */
  findSale(ctx: TenantContext, saleId: Types.ObjectId): Promise<ReturnableSale | null>;
  /**
   * Holds `quantity` of a line against being returned twice. One atomic,
   * guarded update per line, exactly as Clothing does it: two clerks returning
   * the last unit at the same instant cannot both succeed.
   */
  reserve(ctx: TenantContext, saleId: Types.ObjectId, line: { saleItemId: Types.ObjectId; quantity: number; sold: number }): Promise<boolean>;
  /** Gives a held quantity back when the return could not be completed. */
  release(ctx: TenantContext, saleId: Types.ObjectId, lines: { saleItemId: Types.ObjectId; quantity: number }[]): Promise<void>;
  /** Records the money that went back, and whether anything is left to return. */
  applyReturnTotals(ctx: TenantContext, saleId: Types.ObjectId, refundedMinor: number): Promise<void>;
}
