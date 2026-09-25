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
import type { RequestedReturnLine, ReturnableLine, SaleReturnAdapter } from './posReturns.types';

export interface PosReturnInput {
  saleId: Types.ObjectId;
  items: RequestedReturnLine[];
  reason: string;
  refundMethod: string;
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

    const byId = new Map(sale.lines.map((line) => [String(line.saleItemId), line]));
    const prepared: { line: ReturnableLine; quantity: number; restock: boolean; lineTotalMinor: number }[] = [];

    for (const requested of input.items) {
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
        lineTotalMinor: this.refundFor(sale, line, requested.quantity),
      });
    }

    if (prepared.length === 0) throw ApiError.validation('Choose at least one line to return');

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
   * The money a line gives back.
   *
   * A customer who paid 90 for a 100 item because the whole sale was discounted
   * gets 90 back, not 100: the discount is shared out in proportion to what each
   * line contributed. Integer arithmetic throughout, rounded down, so a refund
   * can never come to more than was taken.
   */
  private refundFor(sale: { subtotalMinor: number; discountMinor: number }, line: ReturnableLine, quantity: number): number {
    const gross = line.unitPriceMinor * quantity;
    if (sale.discountMinor <= 0 || sale.subtotalMinor <= 0) return gross;
    return Math.floor((gross * (sale.subtotalMinor - sale.discountMinor)) / sale.subtotalMinor);
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
