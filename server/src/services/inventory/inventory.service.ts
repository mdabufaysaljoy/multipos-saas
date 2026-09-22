import { Types, type ClientSession } from 'mongoose';
import { INVENTORY_TX_TYPES, type InventoryTxType } from '../../config/constants';
import { InventoryTransactionModel } from '../../models/InventoryTransaction';
import { ProductVariantModel, type ProductVariantDoc } from '../../models/ProductVariant';
import { ApiError } from '../../utils/ApiError';
import { sessionOpt } from '../../utils/tx';
import { logger } from '../../utils/logger';
import type { TenantContext } from '../../types/express';

export interface StockMovementRef {
  type: InventoryTxType;
  reason?: string;
  referenceType?: 'sale' | 'return' | 'adjustment' | 'product' | null;
  referenceId?: Types.ObjectId | null;
  referenceNumber?: string;
}

export interface StockMovementResult {
  variantId: Types.ObjectId;
  productId: Types.ObjectId;
  previousStock: number;
  newStock: number;
  quantityChange: number;
  /** Id of the ledger row this movement wrote, so it can be back-referenced. */
  ledgerId: Types.ObjectId | null;
  /** Set when a sale took the variant from zero or below (see `decreaseForSale`). */
  outOfStockOverride?: boolean;
}

type LeanVariant = Pick<
  ProductVariantDoc,
  '_id' | 'productId' | 'stock' | 'name' | 'sku' | 'productNameSnapshot'
>;

/**
 * All stock mutation flows through this service.
 *
 * The central guarantee is that a decrement is a SINGLE atomic document update
 * with a `stock: { $gte: quantity }` precondition. Two concurrent sales for the
 * last unit cannot both succeed: MongoDB applies the updates one at a time and
 * the loser matches zero documents, so it is rejected. This holds on a
 * standalone server with no transaction support, which is why inventory
 * correctness never depends on `withTransaction`.
 */
class InventoryService {
  /**
   * Atomically removes stock. Returns null when there is not enough stock,
   * letting the caller decide between rejecting and compensating.
   */
  async tryDecrease(
    ctx: TenantContext,
    variantId: Types.ObjectId,
    quantity: number,
    ref: StockMovementRef,
    session?: ClientSession,
  ): Promise<StockMovementResult | null> {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw ApiError.badRequest('Stock movement quantity must be a positive whole number');
    }

    // `new: false` returns the pre-image, giving us previousStock for the ledger
    // without a second read that another writer could interleave with.
    const before = await ProductVariantModel.findOneAndUpdate(
      {
        _id: variantId,
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        deletedAt: null,
        stock: { $gte: quantity },
      },
      { $inc: { stock: -quantity } },
      { new: false, ...sessionOpt(session) },
    )
      .select('_id productId stock name sku productNameSnapshot')
      .lean<LeanVariant>();

    if (!before) return null;

    const result: StockMovementResult = {
      variantId: before._id,
      productId: before.productId,
      previousStock: before.stock,
      newStock: before.stock - quantity,
      quantityChange: -quantity,
      ledgerId: null,
    };

    result.ledgerId = await this.writeLedger(ctx, before, result, ref, session);
    return result;
  }

  /** Decrements stock or throws a descriptive INSUFFICIENT_STOCK error. */
  async decrease(
    ctx: TenantContext,
    variantId: Types.ObjectId,
    quantity: number,
    ref: StockMovementRef,
    session?: ClientSession,
  ): Promise<StockMovementResult> {
    const result = await this.tryDecrease(ctx, variantId, quantity, ref, session);
    if (result) return result;

    // Distinguish "gone" from "not enough" so the cashier gets a useful message.
    const variant = await ProductVariantModel.findOne({
      _id: variantId,
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      deletedAt: null,
    })
      .select('name stock sku productNameSnapshot')
      .lean();

    if (!variant) throw ApiError.notFound('That product variant is no longer available');

    throw ApiError.insufficientStock(
      `Not enough stock for ${variant.productNameSnapshot} (${variant.name}). Available: ${variant.stock}, requested: ${quantity}.`,
      { variantId, sku: variant.sku, available: variant.stock, requested: quantity },
    );
  }

  /**
   * The stock movement for a sale line.
   *
   * Normal rule first: stock must cover the quantity. When it does not and
   * `allowOutOfStock` is true (the CALLER decides, from the user's current
   * server-side permissions - never from the request), a second atomic update
   * sells the line only if the variant is at zero or below at that instant.
   * A variant that still has SOME stock but not enough is refused as before:
   * the permission overrides "out of stock", not "not enough stock".
   */
  async decreaseForSale(
    ctx: TenantContext,
    variantId: Types.ObjectId,
    quantity: number,
    ref: StockMovementRef,
    options: { allowOutOfStock: boolean },
  ): Promise<StockMovementResult> {
    if (!options.allowOutOfStock) return this.decrease(ctx, variantId, quantity, ref);

    const normal = await this.tryDecrease(ctx, variantId, quantity, ref);
    if (normal) return normal;

    const before = await ProductVariantModel.findOneAndUpdate(
      { _id: variantId, tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null, stock: { $lte: 0 } },
      { $inc: { stock: -quantity } },
      { new: false },
    )
      .select('_id productId stock name sku productNameSnapshot')
      .lean<LeanVariant>();

    // Gone, or it has some stock but not enough: the normal error explains which.
    if (!before) return this.decrease(ctx, variantId, quantity, ref);

    const result: StockMovementResult = {
      variantId: before._id,
      productId: before.productId,
      previousStock: before.stock,
      newStock: before.stock - quantity,
      quantityChange: -quantity,
      ledgerId: null,
      outOfStockOverride: true,
    };
    result.ledgerId = await this.writeLedger(ctx, before, result, { ...ref, reason: `${ref.reason ?? 'Sale'} (out-of-stock sale)` });
    return result;
  }

  /** Atomically adds stock (returns, purchases, cancellations). */
  async increase(
    ctx: TenantContext,
    variantId: Types.ObjectId,
    quantity: number,
    ref: StockMovementRef,
    session?: ClientSession,
  ): Promise<StockMovementResult> {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw ApiError.badRequest('Stock movement quantity must be a positive whole number');
    }

    const before = await ProductVariantModel.findOneAndUpdate(
      { _id: variantId, tenantId: ctx.tenantId, storeId: ctx.storeId },
      { $inc: { stock: quantity } },
      { new: false, ...sessionOpt(session) },
    )
      .select('_id productId stock name sku productNameSnapshot')
      .lean<LeanVariant>();

    if (!before) throw ApiError.notFound('That product variant no longer exists');

    const result: StockMovementResult = {
      variantId: before._id,
      productId: before.productId,
      previousStock: before.stock,
      newStock: before.stock + quantity,
      quantityChange: quantity,
      ledgerId: null,
    };

    result.ledgerId = await this.writeLedger(ctx, before, result, ref, session);
    return result;
  }

  /**
   * Undoes a set of decrements after a later line failed. Used on the
   * non-transactional code path so a partially applied sale never leaves stock
   * missing. Failures here are logged loudly - they need human reconciliation.
   */
  async compensate(ctx: TenantContext, movements: StockMovementResult[], reason: string): Promise<void> {
    for (const movement of movements) {
      try {
        await this.increase(ctx, movement.variantId, Math.abs(movement.quantityChange), {
          type: INVENTORY_TX_TYPES.MANUAL_ADJUSTMENT,
          reason: `Automatic rollback: ${reason}`,
          referenceType: 'adjustment',
        });
      } catch (error) {
        logger.error('CRITICAL: failed to compensate a stock decrement; manual reconciliation required', {
          tenantId: String(ctx.tenantId),
          variantId: String(movement.variantId),
          quantity: movement.quantityChange,
          error,
        });
      }
    }
  }

  /**
   * Manual adjustment to an absolute target quantity or by a delta. Negative
   * resulting stock is rejected outright.
   */
  async adjust(
    ctx: TenantContext,
    input: { variantId: Types.ObjectId; mode: 'set' | 'delta'; value: number; reason: string },
  ): Promise<StockMovementResult> {
    if (!Number.isSafeInteger(input.value)) {
      throw ApiError.badRequest('Adjustment value must be a whole number');
    }

    if (input.mode === 'delta') {
      if (input.value === 0) throw ApiError.badRequest('Adjustment cannot be zero');
      const ref: StockMovementRef = {
        type: INVENTORY_TX_TYPES.MANUAL_ADJUSTMENT,
        reason: input.reason,
        referenceType: 'adjustment',
      };
      if (input.value > 0) return this.increase(ctx, input.variantId, input.value, ref);
      return this.decrease(ctx, input.variantId, Math.abs(input.value), ref);
    }

    // "set" mode: read then compute the delta, and apply it with a guard on the
    // value we read so a concurrent sale cannot be silently overwritten.
    if (input.value < 0) throw ApiError.badRequest('Stock cannot be set to a negative value');

    const current = await ProductVariantModel.findOne({
      _id: input.variantId,
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      deletedAt: null,
    })
      .select('_id productId stock name sku productNameSnapshot')
      .lean<LeanVariant>();

    if (!current) throw ApiError.notFound('Product variant not found');

    const delta = input.value - current.stock;
    if (delta === 0) {
      return {
        variantId: current._id,
        productId: current.productId,
        previousStock: current.stock,
        newStock: current.stock,
        quantityChange: 0,
        ledgerId: null,
      };
    }

    const updated = await ProductVariantModel.findOneAndUpdate(
      { _id: input.variantId, tenantId: ctx.tenantId, storeId: ctx.storeId, stock: current.stock },
      { $inc: { stock: delta } },
      { new: false },
    )
      .select('_id productId stock name sku productNameSnapshot')
      .lean<LeanVariant>();

    if (!updated) {
      throw ApiError.conflict('Stock changed while you were editing. Reload and try again.');
    }

    const result: StockMovementResult = {
      variantId: updated._id,
      productId: updated.productId,
      previousStock: updated.stock,
      newStock: input.value,
      quantityChange: delta,
      ledgerId: null,
    };

    result.ledgerId = await this.writeLedger(
      ctx,
      updated,
      result,
      { type: INVENTORY_TX_TYPES.MANUAL_ADJUSTMENT, reason: input.reason, referenceType: 'adjustment' },
    );
    return result;
  }

  /** Records the opening balance for a brand new variant. */
  async recordInitialStock(
    ctx: TenantContext,
    variant: { _id: Types.ObjectId; productId: Types.ObjectId; name: string; sku: string; productNameSnapshot: string },
    quantity: number,
    session?: ClientSession,
  ): Promise<void> {
    if (quantity <= 0) return;
    await InventoryTransactionModel.create(
      [
        {
          tenantId: ctx.tenantId,
          storeId: ctx.storeId,
          productId: variant.productId,
          variantId: variant._id,
          productNameSnapshot: variant.productNameSnapshot,
          variantNameSnapshot: variant.name,
          skuSnapshot: variant.sku,
          type: INVENTORY_TX_TYPES.INITIAL_STOCK,
          quantityChange: quantity,
          previousStock: 0,
          newStock: quantity,
          reason: 'Opening stock',
          referenceType: 'product',
          referenceId: variant.productId,
          performedBy: ctx.userId,
          performedByNameSnapshot: ctx.userName,
        },
      ],
      { session },
    );
  }

  /**
   * Stamps the invoice/return number onto ledger rows written moments earlier.
   * Stock has to move before the document number exists, so the reference is
   * backfilled rather than guessed ahead of time.
   */
  async attachReference(
    ctx: TenantContext,
    movements: StockMovementResult[],
    referenceType: 'sale' | 'return',
    referenceId: Types.ObjectId,
    referenceNumber: string,
  ): Promise<void> {
    const ledgerIds = movements.map((m) => m.ledgerId).filter((id): id is Types.ObjectId => id !== null);
    if (ledgerIds.length === 0) return;
    // Targeted by ledger row id, so two concurrent sales of the same variant
    // can never stamp each other's rows.
    await InventoryTransactionModel.updateMany(
      { _id: { $in: ledgerIds }, tenantId: ctx.tenantId, referenceType },
      { $set: { referenceId, referenceNumber } },
    );
  }

  private async writeLedger(
    ctx: TenantContext,
    variant: LeanVariant,
    result: StockMovementResult,
    ref: StockMovementRef,
    session?: ClientSession,
  ): Promise<Types.ObjectId> {
    const [row] = await InventoryTransactionModel.create(
      [
        {
          tenantId: ctx.tenantId,
          storeId: ctx.storeId,
          productId: result.productId,
          variantId: result.variantId,
          productNameSnapshot: variant.productNameSnapshot,
          variantNameSnapshot: variant.name,
          skuSnapshot: variant.sku,
          type: ref.type,
          quantityChange: result.quantityChange,
          previousStock: result.previousStock,
          newStock: result.newStock,
          reason: ref.reason ?? '',
          referenceType: ref.referenceType ?? null,
          referenceId: ref.referenceId ?? null,
          referenceNumber: ref.referenceNumber ?? '',
          performedBy: ctx.userId,
          performedByNameSnapshot: ctx.userName,
          ...(result.outOfStockOverride ? { outOfStockOverride: true } : {}),
        },
      ],
      { session },
    );
    return row._id;
  }
}

export const inventoryService = new InventoryService();
