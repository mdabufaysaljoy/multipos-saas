import { Types } from 'mongoose';
import type { PosVertical } from '../../config/verticals';
import { PERMISSIONS } from '../../config/permissions';
import { ReturnModel } from '../../models/Return';
import { StoreModel } from '../../models/Store';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import { logger } from '../../utils/logger';
import type { TenantContext } from '../../types/express';
import { customerService } from '../../modules/customers/customers.service';
import { inventoryAdapterFor } from '../inventory/adapters';
import { assertMethodsEnabled, POS_TENDER_DIALECT, tenderLabels } from '../pos/paymentMethods.service';
import type { RequestedReturnLine, ReturnableLine, ReturnableSale, SaleReturnAdapter } from './posReturns.types';

export interface PosReturnInput {
  saleId: Types.ObjectId;
  items: RequestedReturnLine[];
  reason: string;
  refundMethod: string;
}

/** The refund method that means "paid for in goods", not in money. */
export const EXCHANGE_REFUND_METHOD = 'exchange';

export interface PosExchangeInput {
  saleId: Types.ObjectId;
  items: RequestedReturnLine[];
  reason: string;
  replacement: {
    items: { itemId: Types.ObjectId; quantity: number }[];
    payments: { method: string; amountMinor: number }[];
  };
  /** Guards the exchange against being submitted twice. */
  idempotencyKey: string;
}

/**
 * Returns, for any POS vertical.
 *
 * Clothing has its own engine, which also does exchanges and loyalty and is not
 * touched here. This is the same shape of thing for the verticals that had only
 * a whole-sale void: choose lines, refund by a tender, put the goods back where
 * that vertical keeps them.
 *
 * The order of operations is what makes it safe without transactions:
 *
 *   1. read the sale and work out what may come back
 *   2. HOLD each quantity on the sale line (atomic, guarded, releasable)
 *   3. put the stock back through the vertical's inventory adapter
 *   4. write the return, then update the sale's returned totals
 *
 * Anything that fails after step 2 releases the held quantities, so a sale can
 * never end up with goods marked returned that were never refunded.
 */
class PosReturnService {
  async create(ctx: TenantContext, adapter: SaleReturnAdapter, input: PosReturnInput) {
    if (!ctx.can(PERMISSIONS.RETURNS_CREATE)) throw ApiError.forbidden('You do not have permission to process returns');

    const sale = await adapter.findSale(ctx, input.saleId);
    if (!sale) throw ApiError.notFound('That sale does not exist. A return must be made against a sale.');

    const store = await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).select('paymentMethods returnPrefix').lean();
    if (!store) throw ApiError.notFound('Branch not found');
    // A refund goes back on a tender the branch actually takes.
    assertMethodsEnabled(store.paymentMethods ?? [], [input.refundMethod], POS_TENDER_DIALECT);

    const prepared = this.prepareLines(adapter, sale, input.items);

    // ---- hold the quantities ------------------------------------------------
    const held: { saleItemId: Types.ObjectId; quantity: number }[] = [];
    for (const entry of prepared) {
      const ok = await adapter.reserve(ctx, sale.saleId, {
        saleItemId: entry.line.saleItemId,
        quantity: entry.quantity,
        sold: entry.line.quantity,
      });
      if (!ok) {
        await adapter.release(ctx, sale.saleId, held);
        throw ApiError.conflict(`"${entry.line.label}" was returned by someone else while you were working. Reload the sale and try again.`);
      }
      held.push({ saleItemId: entry.line.saleItemId, quantity: entry.quantity });
    }

    try {
      // ---- put the goods back ------------------------------------------------
      const inventory = inventoryAdapterFor(adapter.vertical);
      const restocking = prepared.filter((entry) => entry.restock);
      if (inventory.tracksStock && restocking.length > 0) {
        await inventory.restore(
          ctx,
          restocking.map((entry) => this.reservationFor(adapter.vertical, entry.line, entry.quantity)) as never[],
          { reason: input.reason || 'Customer return', referenceId: sale.saleId, referenceNumber: sale.saleNumber },
        );
      }

      // ---- write the return ---------------------------------------------------
      const seq = await nextSequence(ctx.tenantId, ctx.storeId, `${adapter.vertical}-return`);
      const returnNumber = formatDocumentNumber(store.returnPrefix || 'RET-', seq);
      const totalMinor = prepared.reduce((sum, entry) => sum + entry.lineTotalMinor, 0);
      const refundLabel = (await tenderLabels(ctx.tenantId)).get(input.refundMethod) ?? input.refundMethod;

      const [created] = await ReturnModel.create([
        {
          tenantId: ctx.tenantId,
          storeId: ctx.storeId,
          vertical: adapter.vertical,
          returnNumber,
          saleId: sale.saleId,
          saleNumberSnapshot: sale.saleNumber,
          customerId: sale.customerId,
          customerSnapshot: sale.customerId ? { name: sale.customerName, phone: sale.customerPhone } : null,
          items: prepared.map((entry) => ({
            saleItemId: entry.line.saleItemId,
            productId: entry.line.itemId,
            itemId: entry.line.itemId,
            productNameSnapshot: entry.line.label,
            variantNameSnapshot: entry.line.detail,
            skuSnapshot: entry.line.detail,
            quantity: entry.quantity,
            unitPriceMinor: entry.line.unitPriceMinor,
            costPriceMinorSnapshot: entry.line.costPriceMinor,
            costMinor: entry.costMinor,
            lineTotalMinor: entry.lineTotalMinor,
            restock: entry.restock,
            ...(entry.line.allocations
              ? { allocations: this.allocationsFor(entry.line, entry.quantity).map(({ batchId, batchNumber, quantity }) => ({ batchId, batchNumber, quantity })) }
              : {}),
          })),
          totalMinor,
          reason: input.reason,
          refundMethod: input.refundMethod,
          refundMethodLabel: refundLabel,
          processedBy: ctx.userId,
          processedByNameSnapshot: ctx.userName,
          returnedAt: new Date(),
          exchange: null,
          idempotencyKey: null,
          loyalty: null,
        },
      ]);

      await adapter.applyReturnTotals(ctx, sale.saleId, totalMinor);

      // Points follow the goods: what the returned items earned is taken back,
      // and what was spent on them is given back as points rather than money.
      await adapter.reverseLoyalty?.(ctx, sale.saleId, input.reason);

      // A refund is not a purchase: take it back off the customer's lifetime value.
      if (sale.customerId) {
        await customerService.applySaleStats(ctx, sale.customerId, { amountMinor: -totalMinor, orderDelta: 0 });
      }

      return created.toObject();
    } catch (error) {
      await adapter.release(ctx, sale.saleId, held);
      logger.error('A return failed after its quantities were held; they were released', {
        tenantId: String(ctx.tenantId),
        saleId: String(sale.saleId),
        error,
      });
      throw error;
    }
  }

  /**
   * Exchange: the returned goods pay for replacement goods instead of being
   * paid out. Super Shop only today - a vertical without an exchange adapter is
   * refused, so Pharmacy and Restaurant are exactly as they were.
   *
   * Built from the same parts as a return plus an ordinary sale, so stock, VAT,
   * split payment, cash change and the ledger all follow the normal rules:
   *
   *   validate the returned lines   -> refund value from the ORIGINAL prices
   *   quote the replacement         -> today's catalogue prices, server-side
   *   rule: replacement >= refund   -> nobody is paid out for trading down
   *   hold the returned quantities  -> atomic, guarded, releasable
   *   create the replacement sale   -> takes its stock; tenders cover only the
   *                                    difference, because the credit pays the rest
   *   put the returned goods back   -> unless the till says they are damaged
   *   write the return              -> the COMMIT POINT, carrying the key
   *
   * There are no multi-document transactions here, so each failure undoes the
   * steps already taken. The return document is written LAST of the steps that
   * can fail, which is what makes a half-finished exchange impossible to mistake
   * for a finished one; the bookkeeping after it is best-effort and logged.
   *
   * A repeated key returns the first exchange rather than running it again.
   */
  async createExchange(ctx: TenantContext, adapter: SaleReturnAdapter, input: PosExchangeInput) {
    if (!ctx.can(PERMISSIONS.RETURNS_CREATE)) throw ApiError.forbidden('You do not have permission to process returns');
    // It creates a sale, so it needs the permission to create one.
    if (!ctx.can(PERMISSIONS.SALES_CREATE)) throw ApiError.forbidden('You do not have permission to create a sale');

    const exchange = adapter.exchange;
    if (!exchange) throw ApiError.badRequest('Exchanges are not available in this POS type');

    // Submitted twice - a double click, a retried request - is the same exchange.
    const replayed = await this.findExchangeByKey(ctx, adapter.vertical, input.idempotencyKey);
    if (replayed) return replayed;

    const sale = await adapter.findSale(ctx, input.saleId);
    if (!sale) throw ApiError.notFound('That sale does not exist. An exchange must be made against a sale.');

    const store = await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).select('paymentMethods returnPrefix').lean();
    if (!store) throw ApiError.notFound('Branch not found');

    const prepared = this.prepareLines(adapter, sale, input.items);
    const creditMinor = prepared.reduce((sum, entry) => sum + entry.lineTotalMinor, 0);

    // Priced from the catalogue, never from the request, so the rule below is
    // decided on numbers the till cannot choose.
    const quote = await exchange.quote(ctx, input.replacement.items);
    if (quote.subtotalMinor < creditMinor) {
      throw ApiError.validation(
        "The replacement cannot be cheaper than the returned goods. Choose something of equal or higher value, or take a refund instead.",
        { reason: 'EXCHANGE_CHEAPER_REPLACEMENT', creditMinor, replacementSubtotalMinor: quote.subtotalMinor },
      );
    }

    // ---- hold the returned quantities ----------------------------------------
    const held: { saleItemId: Types.ObjectId; quantity: number }[] = [];
    for (const entry of prepared) {
      const ok = await adapter.reserve(ctx, sale.saleId, { saleItemId: entry.line.saleItemId, quantity: entry.quantity, sold: entry.line.quantity });
      if (!ok) {
        await adapter.release(ctx, sale.saleId, held);
        throw ApiError.conflict(`"${entry.line.label}" was returned by someone else while you were working. Reload the sale and try again.`);
      }
      held.push({ saleItemId: entry.line.saleItemId, quantity: entry.quantity });
    }

    const returnedItems = prepared.map((entry) => ({
      nameSnapshot: entry.line.label,
      detailSnapshot: entry.line.detail,
      quantity: entry.quantity,
      unitType: 'each',
      lineTotalMinor: entry.lineTotalMinor,
    }));

    // ---- the replacement sale -------------------------------------------------
    let replacement: Awaited<ReturnType<typeof exchange.create>>;
    try {
      replacement = await exchange.create(ctx, {
        items: input.replacement.items,
        payments: input.replacement.payments,
        customerId: sale.customerId,
        creditMinor,
        originalSaleId: sale.saleId,
        originalSaleNumber: sale.saleNumber,
        returnedItems,
        note: `Exchange for ${sale.saleNumber}`,
      });
    } catch (error) {
      await adapter.release(ctx, sale.saleId, held);
      throw error;
    }

    // ---- put the returned goods back, then commit -----------------------------
    let restocked = false;
    try {
      const inventory = inventoryAdapterFor(adapter.vertical);
      const restocking = prepared.filter((entry) => entry.restock);
      if (inventory.tracksStock && restocking.length > 0) {
        await inventory.restore(
          ctx,
          restocking.map((entry) => this.reservationFor(adapter.vertical, entry.line, entry.quantity)) as never[],
          { reason: input.reason || 'Customer exchange', referenceId: sale.saleId, referenceNumber: sale.saleNumber },
        );
        restocked = true;
      }

      const seq = await nextSequence(ctx.tenantId, ctx.storeId, `${adapter.vertical}-return`);
      const returnNumber = formatDocumentNumber(store.returnPrefix || 'RET-', seq);

      const [created] = await ReturnModel.create([
        {
          tenantId: ctx.tenantId,
          storeId: ctx.storeId,
          vertical: adapter.vertical,
          returnNumber,
          saleId: sale.saleId,
          saleNumberSnapshot: sale.saleNumber,
          customerId: sale.customerId,
          customerSnapshot: sale.customerId ? { name: sale.customerName, phone: sale.customerPhone } : null,
          items: prepared.map((entry) => ({
            saleItemId: entry.line.saleItemId,
            productId: entry.line.itemId,
            itemId: entry.line.itemId,
            productNameSnapshot: entry.line.label,
            variantNameSnapshot: entry.line.detail,
            skuSnapshot: entry.line.detail,
            quantity: entry.quantity,
            unitPriceMinor: entry.line.unitPriceMinor,
            costPriceMinorSnapshot: entry.line.costPriceMinor,
            costMinor: entry.costMinor,
            lineTotalMinor: entry.lineTotalMinor,
            restock: entry.restock,
          })),
          totalMinor: creditMinor,
          reason: input.reason,
          // Nothing was paid out: the value went into the replacement basket.
          refundMethod: EXCHANGE_REFUND_METHOD,
          refundMethodLabel: 'Exchange',
          processedBy: ctx.userId,
          processedByNameSnapshot: ctx.userName,
          returnedAt: new Date(),
          exchange: {
            saleId: replacement.saleId,
            saleNumber: replacement.saleNumber,
            refundableMinor: creditMinor,
            replacementSubtotalMinor: replacement.subtotalMinor,
            replacementTotalMinor: replacement.totalMinor,
            extraPayableMinor: replacement.totalMinor - creditMinor,
          },
          idempotencyKey: input.idempotencyKey,
          loyalty: null,
        },
      ]);

      // ---- bookkeeping, past the commit point ---------------------------------
      // The exchange has happened. None of this can un-happen it, so a failure
      // here is logged rather than thrown: it must not leave the customer with
      // goods and the till with an error.
      try {
        await adapter.applyReturnTotals(ctx, sale.saleId, creditMinor);
        await adapter.reverseLoyalty?.(ctx, sale.saleId, input.reason || 'Customer exchange');
        await exchange.link(ctx, replacement.saleId, created._id, returnNumber);
        // The replacement already added its own total; the returned goods come
        // back off, so lifetime value ends up at the difference actually paid.
        if (sale.customerId) {
          await customerService.applySaleStats(ctx, sale.customerId, { amountMinor: -creditMinor, orderDelta: 0 });
        }
      } catch (error) {
        logger.error('An exchange completed but its bookkeeping did not', {
          tenantId: String(ctx.tenantId),
          returnId: String(created._id),
          replacementSaleId: String(replacement.saleId),
          error,
        });
      }

      return { ...created.toObject(), replacementSale: replacement };
    } catch (error) {
      // Undo in reverse: the replacement sale (which puts its own stock back),
      // the restock, and the holds on the original sale's lines.
      await exchange.cancel(ctx, replacement.saleId, 'Exchange could not be completed').catch(() => undefined);
      if (restocked) {
        logger.error('An exchange failed after the returned goods were put back; the stock is on the shelf and the return was not written', {
          tenantId: String(ctx.tenantId),
          saleId: String(sale.saleId),
        });
      }
      await adapter.release(ctx, sale.saleId, held);
      // Two tills running the same exchange: the loser reports the winner's.
      if ((error as { code?: number }).code === 11000) {
        const winner = await this.findExchangeByKey(ctx, adapter.vertical, input.idempotencyKey);
        if (winner) return winner;
      }
      throw error;
    }
  }

  /** The exchange a key has already produced, if any. */
  private async findExchangeByKey(ctx: TenantContext, vertical: PosVertical, idempotencyKey: string) {
    const doc = await ReturnModel.findOne({ tenantId: ctx.tenantId, storeId: ctx.storeId, vertical, idempotencyKey }).lean();
    return doc ? { ...doc, replayed: true } : null;
  }

  /**
   * What may come back, and what each line gives back.
   *
   * Extracted so a return and an exchange decide it identically - an exchange
   * that valued the returned goods differently from a refund would be a way to
   * launder money out of the till.
   */
  private prepareLines(adapter: SaleReturnAdapter, sale: ReturnableSale, items: RequestedReturnLine[]) {
    const byId = new Map(sale.lines.map((line) => [String(line.saleItemId), line]));
    const prepared: { line: ReturnableLine; quantity: number; restock: boolean; lineTotalMinor: number; costMinor: number }[] = [];

    for (const requested of items) {
      const line = byId.get(String(requested.saleItemId));
      if (!line) throw ApiError.badRequest('One of the selected lines does not belong to this sale', { saleItemId: requested.saleItemId });

      const returnable = line.quantity - line.returnedQuantity;
      if (returnable <= 0) {
        throw ApiError.badRequest(`"${line.label}" has already been fully returned`, {
          saleItemId: requested.saleItemId,
          sold: line.quantity,
          alreadyReturned: line.returnedQuantity,
        });
      }
      if (requested.quantity > returnable) {
        throw ApiError.badRequest(
          `You can return at most ${returnable} of "${line.label}". Sold ${line.quantity}, already returned ${line.returnedQuantity}.`,
          { saleItemId: requested.saleItemId, sold: line.quantity, alreadyReturned: line.returnedQuantity, maxReturnable: returnable },
        );
      }

      prepared.push({
        line,
        quantity: requested.quantity,
        restock: requested.restock,
        // What was actually paid for these units: the line's own price, less
        // its share of any discount taken off the whole sale.
        lineTotalMinor: this.refundFor(adapter, sale, line, requested.quantity),
        // And what they cost the shop, in the same unit.
        costMinor: this.costFor(adapter, line, requested.quantity),
      });
    }

    if (prepared.length === 0) throw ApiError.validation('Choose at least one line to return');
    return prepared;
  }

  /**
   * The money a line gives back.
   *
   * A customer who paid 90 for a 100 item because the whole sale was discounted
   * gets 90 back, not 100: the discount is shared out in proportion to what each
   * line contributed. Integer arithmetic throughout, rounded down, so a refund
   * can never come to more than was taken.
   */
  private refundFor(adapter: SaleReturnAdapter, sale: { subtotalMinor: number; discountMinor: number }, line: ReturnableLine, quantity: number): number {
    // What these units were SOLD for. Not `unitPriceMinor * quantity`: a Super
    // Shop weighs in grams and prices per kilogram, so that product is a
    // thousand times the real figure and would refund a thousand times the
    // money. Where a quantity really is a count of things - Pharmacy,
    // Restaurant - the default is exactly that multiplication.
    const gross = adapter.amountOf ? adapter.amountOf(line, quantity) : line.unitPriceMinor * quantity;
    if (sale.discountMinor <= 0 || sale.subtotalMinor <= 0) return gross;
    return Math.floor((gross * (sale.subtotalMinor - sale.discountMinor)) / sale.subtotalMinor);
  }

  /** What `quantity` of this line cost the shop, in the vertical's own unit. */
  private costFor(adapter: SaleReturnAdapter, line: ReturnableLine, quantity: number): number {
    return adapter.costOf ? adapter.costOf(line, quantity) : line.costPriceMinor * quantity;
  }

  /** The batches (earliest first) `quantity` units of this line came from. */
  private allocationsFor(line: ReturnableLine, quantity: number) {
    const taken: NonNullable<ReturnableLine['allocations']> = [];
    let remaining = quantity;
    for (const allocation of line.allocations ?? []) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, allocation.quantity);
      taken.push({ ...allocation, quantity: take });
      remaining -= take;
    }
    return taken;
  }

  /** The shape this vertical's inventory adapter needs to put the goods back. */
  private reservationFor(vertical: PosVertical, line: ReturnableLine, quantity: number) {
    if (vertical === 'pharmacy') {
      return {
        itemId: line.itemId,
        quantity,
        balanceAfter: 0,
        detail: {
          medicineName: line.label,
          allocations: this.allocationsFor(line, quantity).map((allocation) => ({
            ...allocation,
            expiryDate: new Date(0),
            balanceAfter: 0,
          })),
        },
      };
    }
    return {
      itemId: line.itemId,
      quantity,
      balanceAfter: 0,
      detail: { productName: line.label, unitType: line.detail === 'by weight' ? 'weight' : 'each', costPriceMinor: line.costPriceMinor },
    };
  }
}

export const posReturnService = new PosReturnService();
