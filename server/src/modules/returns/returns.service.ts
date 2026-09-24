import { Types } from 'mongoose';
import { INVENTORY_TX_TYPES, SALE_STATUS } from '../../config/constants';
import { ReturnModel, type ReturnExchange } from '../../models/Return';
import { SaleModel } from '../../models/Sale';
import { StoreModel } from '../../models/Store';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { inventoryService, type StockMovementResult } from '../../services/inventory/inventory.service';
import { tenderLabels } from '../../services/pos/paymentMethods.service';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { customerService } from '../customers/customers.service';
import type { TenantContext } from '../../types/express';
import { EXCHANGE_REFUND_METHOD, type CreateReturnInput, type ListReturnsInput } from './returns.validators';
import { saleService } from '../sales/sales.service';
import { loyaltyService } from '../loyalty/loyalty.service';
import type { CreateSaleInput } from '../sales/sales.validators';

interface PreparedReturnLine {
  saleItemId: Types.ObjectId;
  productId: Types.ObjectId;
  variantId: Types.ObjectId;
  productNameSnapshot: string;
  variantNameSnapshot: string;
  skuSnapshot: string;
  categoryId: Types.ObjectId | null;
  categoryNameSnapshot: string;
  quantity: number;
  unitPriceMinor: number;
  costPriceMinorSnapshot: number;
  lineTotalMinor: number;
  restock: boolean;
}

class ReturnService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, storeId: ctx.storeId };
  }

  /**
   * Shows what is still returnable on a sale: sold quantity minus everything
   * already returned. This is the same arithmetic the write path enforces, so
   * the UI and the server can never disagree about the cap.
   */
  async getReturnableSale(ctx: TenantContext, saleId: Types.ObjectId) {
    const sale = await SaleModel.findOne({ _id: saleId, ...this.scope(ctx) }).lean();
    if (!sale) throw ApiError.notFound('Sale not found');

    if (sale.status === SALE_STATUS.CANCELLED) {
      throw ApiError.badRequest('This sale was cancelled - its stock has already been restored');
    }

    return {
      sale: {
        id: sale._id,
        saleNumber: sale.saleNumber,
        soldAt: sale.soldAt,
        customerSnapshot: sale.customerSnapshot,
        cashierNameSnapshot: sale.cashierNameSnapshot,
        totalMinor: sale.totalMinor,
        returnedTotalMinor: sale.returnedTotalMinor,
        subtotalMinor: sale.subtotalMinor,
        status: sale.status,
        // Enough for the return screen to preview the points effect; the server recalculates on submit.
        loyalty: sale.loyalty
          ? {
              cardNumber: sale.loyalty.cardNumber,
              pointValueMinor: sale.loyalty.pointValueMinor,
              earnSpendMinor: sale.loyalty.earnSpendMinor,
              pointsRedeemed: sale.loyalty.pointsRedeemed,
              qualifyingMinor: sale.loyalty.qualifyingMinor,
              pointsEarned: sale.loyalty.pointsEarned,
              pointsEarnedReversed: sale.loyalty.pointsEarnedReversed,
              pointsRedeemedRestored: sale.loyalty.pointsRedeemedRestored,
            }
          : null,
      },
      items: sale.items.map((item) => ({
        saleItemId: item._id,
        productId: item.productId,
        variantId: item.variantId,
        productName: item.productNameSnapshot,
        variantName: item.variantNameSnapshot,
        sku: item.skuSnapshot,
        unitPriceMinor: item.unitPriceMinor,
        soldQuantity: item.quantity,
        returnedQuantity: item.returnedQuantity,
        returnableQuantity: item.quantity - item.returnedQuantity,
        lineTotalMinor: item.lineTotalMinor,
      })),
      fullyReturned: sale.fullyReturned,
    };
  }

  /**
   * Processes a return against a sale.
   *
   * The critical invariant - never refund more than was bought - is enforced by
   * an atomic, conditional update per line:
   *
   *   updateOne({ _id: sale, items._id: line, items.returnedQuantity: { $lte: sold - qty } },
   *             { $inc: { items.$.returnedQuantity: qty } })
   *
   * Two clerks returning the last unit at the same instant cannot both succeed:
   * the second update matches zero documents and is rejected. Only after every
   * line reserves its quantity does stock actually move.
   */
  async create(ctx: TenantContext, input: CreateReturnInput) {
    const { sale, store, itemById, lines } = await this.prepare(ctx, input);
    const reserved = await this.reserve(ctx, sale._id, itemById, lines);
    return this.finalize(ctx, input, { sale, store, lines, reserved });
  }

  /**
   * Exchange: the returned items' refund value pays for replacement goods
   * instead of being paid out. Built from the same steps as a return plus an
   * ordinary replacement sale, so stock, variants, VAT, split payment and cash
   * change all follow the normal rules.
   *
   *   validate the return lines      -> refund value from the ORIGINAL sale prices
   *   quote the replacement          -> catalogue price of the exact variants chosen
   *   rule: replacement >= refund    -> nobody is paid out for trading down
   *   reserve returned quantities    -> atomic, releasable
   *   create the replacement sale    -> deducts replacement stock; payments must
   *                                     cover exactly (total - refund value)
   *   restock + write the return     -> refundMethod "exchange", linked both ways
   *
   * There are no multi-document transactions in this deployment, so every
   * failure undoes the steps already taken (the same pattern returns and sales
   * already use). A repeated key returns the first exchange instead of running
   * it again.
   */
  async createExchange(ctx: TenantContext, input: CreateReturnInput) {
    const exchange = input.exchange;
    if (input.refundMethod !== EXCHANGE_REFUND_METHOD || !exchange) {
      throw ApiError.validation('Select the replacement product for this exchange');
    }

    const existing = await this.findExchangeByKey(ctx, exchange.idempotencyKey);
    if (existing) return existing;

    const { sale, store, itemById, lines } = await this.prepare(ctx, input);
    const refundableMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);

    // The rule is checked before anything moves. Prices come from the database.
    const quote = await saleService.quoteReplacement(ctx, exchange.items);
    if (quote.subtotalMinor < refundableMinor) {
      throw ApiError.validation(
        "Exchange product cannot be cheaper than the returned item's refund value. Please select a product with an equal or higher price.",
        { reason: 'EXCHANGE_CHEAPER_REPLACEMENT', refundableMinor, replacementSubtotalMinor: quote.subtotalMinor },
      );
    }
    const reserved = await this.reserve(ctx, sale._id, itemById, lines);

    // Points spent on the returned goods come back as points, so the credit is
    // only what the customer paid in money for them.
    let loyaltyClaim: Awaited<ReturnType<typeof loyaltyService.claimReturn>> = null;
    try {
      loyaltyClaim = await loyaltyService.claimReturn(ctx, sale._id);
    } catch (error) {
      await this.releaseReservations(ctx, sale._id, reserved);
      throw error;
    }
    const creditMinor = Math.max(0, refundableMinor - (loyaltyClaim?.valueMinor ?? 0));

    let replacement: Awaited<ReturnType<typeof saleService.create>>;
    try {
      const payments = exchange.payments ?? [];
      replacement = await saleService.create(
        ctx,
        {
          items: exchange.items,
          customerId: sale.customerId ?? undefined,
          discountType: 'none',
          discountValue: 0,
          paymentMethod: payments.length ? [...payments].sort((a, b) => b.amountMinor - a.amountMinor)[0].method : 'other',
          payments: payments.length ? payments : undefined,
          cashTenderedMinor: exchange.cashTenderedMinor,
          note: `Exchange for ${sale.saleNumber}`,
        } as CreateSaleInput,
        {
          // The replacement earns points on the original card, while the returned goods' points are taken back.
          loyaltyMembershipId: sale.loyalty?.membershipId ?? undefined,
          exchange: {
            creditMinor,
            returnedItems: lines.map((line) => ({
              productNameSnapshot: line.productNameSnapshot,
              variantNameSnapshot: line.variantNameSnapshot,
              quantity: line.quantity,
              lineTotalMinor: line.lineTotalMinor,
            })),
          },
        },
      );
    } catch (error) {
      await this.releaseReservations(ctx, sale._id, reserved);
      await loyaltyService.releaseReturnClaim(ctx, sale._id, loyaltyClaim);
      throw error;
    }

    try {
      const returnDoc = await this.finalize(ctx, input, {
        sale,
        store,
        lines,
        reserved,
        exchange: {
          saleId: replacement._id,
          saleNumber: replacement.saleNumber,
          refundableMinor: creditMinor,
          replacementSubtotalMinor: replacement.subtotalMinor,
          replacementTotalMinor: replacement.totalMinor,
          extraPayableMinor: replacement.totalMinor - creditMinor,
        },
        idempotencyKey: exchange.idempotencyKey,
        loyaltyClaim,
      });
      await SaleModel.updateOne(
        { _id: replacement._id, tenantId: ctx.tenantId },
        { $set: { 'exchange.returnId': returnDoc._id, 'exchange.returnNumber': returnDoc.returnNumber } },
      );
      return { ...returnDoc, replacementSale: { ...replacement, exchange: { ...replacement.exchange, returnId: returnDoc._id, returnNumber: returnDoc.returnNumber } } };
    } catch (error) {
      // finalize already undid its restock and released the reservations; the
      // replacement sale is the last thing to undo. Its stock goes back too.
      await saleService
        .cancel(ctx, replacement._id, { reason: 'Exchange could not be completed' })
        .catch(() => undefined);
      // A duplicate key means the same exchange already went through: return it.
      if ((error as { code?: number }).code === 11000) {
        const winner = await this.findExchangeByKey(ctx, exchange.idempotencyKey);
        if (winner) return winner;
      }
      throw error;
    }
  }

  /** The exchange a key already produced, with its replacement sale. */
  private async findExchangeByKey(ctx: TenantContext, idempotencyKey: string) {
    const doc = await ReturnModel.findOne({ ...this.scope(ctx), idempotencyKey }).lean();
    if (!doc) return null;
    const replacementSale = doc.exchange ? await SaleModel.findOne({ _id: doc.exchange.saleId, ...this.scope(ctx) }).lean() : null;
    return { ...doc, replacementSale, replayed: true };
  }

  /** Loads the sale in this branch and validates every requested line. Changes nothing. */
  private async prepare(ctx: TenantContext, input: CreateReturnInput) {
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertUsable(entitlement);

    const sale = await SaleModel.findOne({ _id: input.saleId, ...this.scope(ctx) }).lean();
    if (!sale) throw ApiError.notFound('That sale does not exist. A return must be made against a sale.');
    if (sale.status === SALE_STATUS.CANCELLED) {
      throw ApiError.badRequest('This sale was cancelled and cannot be returned against');
    }

    const store = await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).lean();
    if (!store) throw ApiError.notFound('Store not found');

    const itemById = new Map(sale.items.map((item) => [String(item._id), item]));
    const lines: PreparedReturnLine[] = [];

    for (const requested of input.items) {
      const saleItem = itemById.get(String(requested.saleItemId));
      if (!saleItem) {
        throw ApiError.badRequest('One of the selected lines does not belong to this sale', {
          saleItemId: requested.saleItemId,
        });
      }

      const alreadyReturned = saleItem.returnedQuantity;
      const returnable = saleItem.quantity - alreadyReturned;

      if (returnable <= 0) {
        throw ApiError.badRequest(
          `"${saleItem.productNameSnapshot} (${saleItem.variantNameSnapshot})" has already been fully returned`,
          { saleItemId: requested.saleItemId, sold: saleItem.quantity, alreadyReturned },
        );
      }

      if (requested.quantity > returnable) {
        throw ApiError.badRequest(
          `You can return at most ${returnable} of "${saleItem.productNameSnapshot} (${saleItem.variantNameSnapshot})". ` +
            `Sold ${saleItem.quantity}, already returned ${alreadyReturned}.`,
          { saleItemId: requested.saleItemId, sold: saleItem.quantity, alreadyReturned, maxReturnable: returnable },
        );
      }

      lines.push({
        saleItemId: saleItem._id,
        productId: saleItem.productId,
        variantId: saleItem.variantId,
        productNameSnapshot: saleItem.productNameSnapshot,
        variantNameSnapshot: saleItem.variantNameSnapshot,
        skuSnapshot: saleItem.skuSnapshot,
        categoryId: saleItem.categoryId,
        categoryNameSnapshot: saleItem.categoryNameSnapshot,
        quantity: requested.quantity,
        // Always the historical price, never today's catalogue price.
        unitPriceMinor: saleItem.unitPriceMinor,
        // Carried from the sale so returned COGS can be backed out of profit.
        costPriceMinorSnapshot: saleItem.costPriceMinorSnapshot,
        lineTotalMinor: saleItem.unitPriceMinor * requested.quantity,
        restock: requested.restock,
      });
    }

    return { sale, store, itemById, lines };
  }

  /** Reserves every returned quantity atomically; releases them all if any line loses a race. */
  private async reserve(
    ctx: TenantContext,
    saleId: Types.ObjectId,
    itemById: Map<string, { quantity: number }>,
    lines: PreparedReturnLine[],
  ) {
    const reserved: PreparedReturnLine[] = [];
    try {
      for (const line of lines) {
        const saleItem = itemById.get(String(line.saleItemId))!;
        const maxAllowedAfter = saleItem.quantity - line.quantity;

        const result = await SaleModel.updateOne(
          {
            _id: saleId,
            tenantId: ctx.tenantId,
            storeId: ctx.storeId,
            items: { $elemMatch: { _id: line.saleItemId, returnedQuantity: { $lte: maxAllowedAfter } } },
          },
          { $inc: { 'items.$.returnedQuantity': line.quantity } },
        );

        if (result.matchedCount === 0) {
          throw ApiError.conflict(
            `"${line.productNameSnapshot} (${line.variantNameSnapshot})" was returned by someone else while you were working. Reload the sale and try again.`,
          );
        }
        reserved.push(line);
      }
    } catch (error) {
      await this.releaseReservations(ctx, saleId, reserved);
      throw error;
    }
    return reserved;
  }

  /** Restocks, writes the return document and refreshes the sale's roll-ups. Undoes itself on failure. */
  private async finalize(
    ctx: TenantContext,
    input: CreateReturnInput,
    state: {
      sale: { _id: Types.ObjectId; saleNumber: string; customerId: Types.ObjectId | null; customerSnapshot: { name: string; phone: string } | null };
      store: { returnPrefix: string };
      lines: PreparedReturnLine[];
      reserved: PreparedReturnLine[];
      exchange?: ReturnExchange;
      idempotencyKey?: string;
      /** Already claimed by the exchange; an ordinary return claims its own. */
      loyaltyClaim?: Awaited<ReturnType<typeof loyaltyService.claimReturn>>;
    },
  ) {
    const { sale, store, lines, reserved } = state;
    const restocked: StockMovementResult[] = [];
    let loyaltyClaim = state.loyaltyClaim ?? null;
    try {
      if (state.loyaltyClaim === undefined) loyaltyClaim = await loyaltyService.claimReturn(ctx, sale._id);

      for (const line of lines) {
        if (!line.restock) continue;
        const movement = await inventoryService.increase(ctx, line.variantId, line.quantity, {
          type: INVENTORY_TX_TYPES.RETURN,
          reason: input.reason || (state.exchange ? 'Customer exchange' : 'Customer return'),
          referenceType: 'return',
        });
        restocked.push(movement);
      }

      const seq = await nextSequence(ctx.tenantId, ctx.storeId, 'return');
      const returnNumber = formatDocumentNumber(store.returnPrefix, seq);
      // An exchange pays nothing back; anything else names the tender it went
      // back on, as the workspace calls it today.
      const refundTenderName =
        input.refundMethod === EXCHANGE_REFUND_METHOD ? '' : ((await tenderLabels(ctx.tenantId)).get(input.refundMethod) ?? input.refundMethod);
      // Money refunded = the goods at their sale prices, less the value of any
      // loyalty points that paid for them (those are given back as points).
      const totalMinor = Math.max(0, lines.reduce((sum, line) => sum + line.lineTotalMinor, 0) - (loyaltyClaim?.valueMinor ?? 0));

      const returnDoc = await ReturnModel.create({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        returnNumber,
        saleId: sale._id,
        saleNumberSnapshot: sale.saleNumber,
        customerId: sale.customerId,
        customerSnapshot: sale.customerSnapshot
          ? { name: sale.customerSnapshot.name, phone: sale.customerSnapshot.phone }
          : null,
        items: lines,
        totalMinor,
        reason: input.reason,
        refundMethod: input.refundMethod,
        // The name that method had when the money went back, so renaming it
        // later cannot change what the return document says.
        refundMethodLabel: refundTenderName,
        processedBy: ctx.userId,
        processedByNameSnapshot: ctx.userName,
        returnedAt: new Date(),
        exchange: state.exchange ?? null,
        idempotencyKey: state.idempotencyKey ?? null,
        loyalty: loyaltyClaim
          ? {
              membershipId: loyaltyClaim.membershipId,
              pointsEarnedReversed: loyaltyClaim.pointsEarnedReversed,
              pointsRedeemedRestored: loyaltyClaim.pointsRedeemedRestored,
              valueMinor: loyaltyClaim.valueMinor,
            }
          : null,
      });

      await inventoryService.attachReference(ctx, restocked, 'return', returnDoc._id, returnNumber);

      // Refresh the sale's roll-up figures.
      const refreshed = await SaleModel.findOne({ _id: sale._id, tenantId: ctx.tenantId }).lean();
      const fullyReturned = Boolean(refreshed?.items.every((item) => item.returnedQuantity >= item.quantity));
      await SaleModel.updateOne(
        { _id: sale._id, tenantId: ctx.tenantId },
        { $inc: { returnedTotalMinor: totalMinor }, $set: { fullyReturned } },
      );

      if (sale.customerId) {
        await customerService.applySaleStats(ctx, sale.customerId, { amountMinor: -totalMinor, orderDelta: 0 });
      }

      if (loyaltyClaim) {
        await loyaltyService.applyReturnClaim(ctx, loyaltyClaim, {
          key: `return:${returnDoc._id}`,
          saleId: sale._id,
          saleNumber: sale.saleNumber,
          returnId: returnDoc._id,
          returnNumber,
          reason: state.exchange ? 'Goods exchanged' : 'Goods returned',
        });
      }

      return returnDoc.toObject();
    } catch (error) {
      // Undo in reverse order: stock first, then the reservations and the loyalty claim.
      await inventoryService.compensate(ctx, restocked, 'return could not be completed');
      await this.releaseReservations(ctx, sale._id, reserved);
      await loyaltyService.releaseReturnClaim(ctx, sale._id, loyaltyClaim);
      throw error;
    }
  }

  async list(ctx: TenantContext, input: ListReturnsInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { ...this.scope(ctx) };

    if (input.saleId) filter.saleId = input.saleId;
    if (input.from || input.to) {
      filter.returnedAt = { ...(input.from ? { $gte: input.from } : {}), ...(input.to ? { $lte: input.to } : {}) };
    }
    if (input.search) {
      const rx = searchRegex(input.search);
      filter.$or = [{ returnNumber: rx }, { saleNumberSnapshot: rx }, { 'customerSnapshot.name': rx }, { 'customerSnapshot.phone': rx }];
    }

    const [items, total] = await Promise.all([
      ReturnModel.find(filter).sort({ returnedAt: input.order === 'asc' ? 1 : -1 }).skip(skip).limit(limit).lean(),
      ReturnModel.countDocuments(filter),
    ]);

    return { items, page, limit, total };
  }

  async getById(ctx: TenantContext, id: Types.ObjectId) {
    const doc = await ReturnModel.findOne({ _id: id, ...this.scope(ctx) }).lean();
    if (!doc) throw ApiError.notFound('Return not found');
    return doc;
  }

  /** Gives back reserved quantities when a later step fails. */
  private async releaseReservations(ctx: TenantContext, saleId: Types.ObjectId, reserved: PreparedReturnLine[]) {
    for (const line of reserved) {
      await SaleModel.updateOne(
        { _id: saleId, tenantId: ctx.tenantId, 'items._id': line.saleItemId },
        { $inc: { 'items.$.returnedQuantity': -line.quantity } },
      );
    }
  }
}

export const returnService = new ReturnService();
