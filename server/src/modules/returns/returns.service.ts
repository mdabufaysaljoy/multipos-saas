import { Types } from 'mongoose';
import { INVENTORY_TX_TYPES, SALE_STATUS } from '../../config/constants';
import { ReturnModel } from '../../models/Return';
import { SaleModel } from '../../models/Sale';
import { StoreModel } from '../../models/Store';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { inventoryService, type StockMovementResult } from '../../services/inventory/inventory.service';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { customerService } from '../customers/customers.service';
import type { TenantContext } from '../../types/express';
import type { CreateReturnInput, ListReturnsInput } from './returns.validators';

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
        status: sale.status,
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

    // ---- validate every line before touching anything ----------------------
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
        lineTotalMinor: saleItem.unitPriceMinor * requested.quantity,
        restock: requested.restock,
      });
    }

    // ---- reserve the returned quantities atomically ------------------------
    const reserved: PreparedReturnLine[] = [];
    try {
      for (const line of lines) {
        const saleItem = itemById.get(String(line.saleItemId))!;
        const maxAllowedAfter = saleItem.quantity - line.quantity;

        const result = await SaleModel.updateOne(
          {
            _id: sale._id,
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
      await this.releaseReservations(ctx, sale._id, reserved);
      throw error;
    }

    // ---- move stock and write the return document --------------------------
    const restocked: StockMovementResult[] = [];
    try {
      for (const line of lines) {
        if (!line.restock) continue;
        const movement = await inventoryService.increase(ctx, line.variantId, line.quantity, {
          type: INVENTORY_TX_TYPES.RETURN,
          reason: input.reason || 'Customer return',
          referenceType: 'return',
        });
        restocked.push(movement);
      }

      const seq = await nextSequence(ctx.tenantId, ctx.storeId, 'return');
      const returnNumber = formatDocumentNumber(store.returnPrefix, seq);
      const totalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);

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
        processedBy: ctx.userId,
        processedByNameSnapshot: ctx.userName,
        returnedAt: new Date(),
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

      return returnDoc.toObject();
    } catch (error) {
      // Undo in reverse order: stock first, then the reservations.
      await inventoryService.compensate(ctx, restocked, 'return could not be completed');
      await this.releaseReservations(ctx, sale._id, reserved);
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
