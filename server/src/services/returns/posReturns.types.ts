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
  /**
   * How the quantity is measured, where that is not simply "one of them".
   * Super Shop weighs in grams and prices per kilogram; nothing else sets it.
   */
  unitType?: 'each' | 'weight';
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
  /**
   * Takes back the points the returned goods earned, and gives back the points
   * that were spent on them. Only the verticals that run a loyalty program
   * implement it; the engine calls it if it is there.
   */
  reverseLoyalty?(ctx: TenantContext, saleId: Types.ObjectId, reason: string): Promise<void>;
  /**
   * What `quantity` of this line was SOLD for, and what it COST.
   *
   * The default - unit price times quantity - is right wherever a quantity is a
   * count of things, which is Pharmacy and Restaurant. It is WRONG for Super
   * Shop's weighed goods, where the quantity is in grams and the price is per
   * kilogram, so `20,000 x 1000` is a thousand times the real figure. A vertical
   * that measures in anything other than whole units implements these.
   */
  amountOf?(line: ReturnableLine, quantity: number): number;
  costOf?(line: ReturnableLine, quantity: number): number;
  /**
   * Exchange support. OPTIONAL, and implemented by Super Shop only: the engine
   * refuses an exchange when a vertical has not provided it, so Pharmacy and
   * Restaurant behave exactly as they did. A restaurant has nothing to swap -
   * the food is gone - and a pharmacy trading one batch for another needs an
   * expiry and dispensing decision that is its own piece of work.
   */
  exchange?: SaleExchangeAdapter;
}

/** A replacement basket, priced by the server from the catalogue. */
export interface ExchangeQuote {
  /** Replacement goods at today's catalogue prices. */
  subtotalMinor: number;
  /** What the replacement sale will come to once the vertical's rules apply. */
  totalMinor: number;
  lines: { itemId: Types.ObjectId; label: string; detail: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
}

/** The replacement sale, as the engine needs to report and unwind it. */
export interface ReplacementSale {
  saleId: Types.ObjectId;
  saleNumber: string;
  subtotalMinor: number;
  totalMinor: number;
  paidMinor: number;
  changeMinor: number;
}

/** What a vertical must be able to do before it can offer exchanges. */
export interface SaleExchangeAdapter {
  /**
   * Prices the replacement basket from the catalogue. Never from the request:
   * the whole point of quoting server-side is that the cheaper-replacement rule
   * is decided on prices the client cannot choose.
   */
  quote(ctx: TenantContext, items: { itemId: Types.ObjectId; quantity: number }[]): Promise<ExchangeQuote>;
  /**
   * Creates the replacement sale, with `creditMinor` already paid for by the
   * returned goods. It takes its own stock and writes its own ledger rows, so
   * an exchange moves inventory exactly as a return plus a sale would.
   */
  create(
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
  ): Promise<ReplacementSale>;
  /** Undoes a replacement sale when the exchange could not be finished. */
  cancel(ctx: TenantContext, saleId: Types.ObjectId, reason: string): Promise<void>;
  /** Points the replacement sale back at the return that paid for it. */
  link(ctx: TenantContext, saleId: Types.ObjectId, returnId: Types.ObjectId, returnNumber: string): Promise<void>;
}
