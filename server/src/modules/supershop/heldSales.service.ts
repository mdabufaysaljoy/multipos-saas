import { Types } from 'mongoose';
import { PERMISSIONS } from '../../config/permissions';
import { ShopHeldSaleModel } from '../../models/ShopHeldSale';
import { ShopProductModel } from '../../models/ShopProduct';
import { ShopStockModel } from '../../models/ShopStock';
import { lineAmount } from '../../models/shopUnits';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import type { TenantContext } from '../../types/express';
import type { HoldSaleInput } from './supershop.validators';

/**
 * Putting a Super Shop basket aside, and picking it up again.
 *
 * A held basket has taken NOTHING: no stock, no money, no points, no sale
 * number. It is a note of what the cashier had in front of them.
 *
 * STALE HOLDS. A hold lives for `HOLD_TTL_DAYS` and then MongoDB removes it
 * through the TTL index on `expiresAt`. Touching one pushes that forward, so a
 * basket somebody is genuinely coming back to survives, and one parked and
 * forgotten on a Friday is gone by the following week without anybody sweeping.
 * No job, no leader election, no cron - which matters in a deployment that runs
 * its schedulers in-process.
 *
 * CLAIM ON RESUME. Resuming REMOVES the hold, in one atomic `findOneAndDelete`.
 * Two tills opening the same parked basket at the same moment cannot both get
 * it: the loser is told it has already been taken. That is what makes a held
 * sale impossible to complete twice - there is nothing left to resume from. The
 * trade is that a till which resumes and then crashes has lost the parked
 * basket; the cashier holds it again, which is one button.
 */

/** How long a parked basket survives untouched. */
export const HOLD_TTL_DAYS = 7;
/** A branch keeps at most this many at once, so the list stays a list. */
export const MAX_HOLDS_PER_BRANCH = 50;

const expiryFromNow = () => new Date(Date.now() + HOLD_TTL_DAYS * 24 * 60 * 60 * 1000);

class HeldSaleService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, storeId: ctx.storeId };
  }

  /**
   * Parks the basket. Prices are read from the catalogue for the estimate shown
   * in the list; nothing the client sends about money is stored.
   */
  async hold(ctx: TenantContext, input: HoldSaleInput) {
    if (!ctx.can(PERMISSIONS.SALES_CREATE)) throw ApiError.forbidden('You do not have permission to take a sale');

    const held = await ShopHeldSaleModel.countDocuments(this.scope(ctx));
    if (held >= MAX_HOLDS_PER_BRANCH) {
      throw ApiError.conflict(`This branch already has ${MAX_HOLDS_PER_BRANCH} held sales. Finish or delete one first.`, {
        reason: 'TOO_MANY_HOLDS',
        limit: MAX_HOLDS_PER_BRANCH,
      });
    }

    const products = await ShopProductModel.find({
      _id: { $in: input.items.map((item) => item.productId) },
      tenantId: ctx.tenantId,
      deletedAt: null,
    }).lean();

    const lines = input.items.map((item) => {
      const product = products.find((entry) => entry._id.equals(item.productId));
      if (!product) throw ApiError.badRequest('One of the items is not in this shop');
      return {
        productId: product._id,
        quantity: item.quantity,
        nameSnapshot: product.name,
        unitType: product.unitType,
        unitPriceMinorSnapshot: product.priceMinor,
      };
    });

    const estimatedTotalMinor = Math.max(
      0,
      lines.reduce((sum, line) => sum + lineAmount(line.unitPriceMinorSnapshot, line.quantity, line.unitType), 0) - input.discountMinor,
    );

    const seq = await nextSequence(ctx.tenantId, ctx.storeId, 'supershop-hold');
    const created = await ShopHeldSaleModel.create({
      ...this.scope(ctx),
      holdNumber: formatDocumentNumber('HOLD-', seq),
      label: input.label,
      items: lines,
      customerId: input.customerId ?? null,
      customerDraft: input.customer ? { name: input.customer.name, phone: input.customer.phone } : null,
      discountMinor: input.discountMinor,
      loyaltyCardNumber: input.loyaltyCardNumber,
      note: input.note,
      estimatedTotalMinor,
      heldBy: ctx.userId,
      heldByNameSnapshot: ctx.userName,
      expiresAt: expiryFromNow(),
    });
    return created.toObject();
  }

  /** This branch's parked baskets, newest first. Never another branch's. */
  async list(ctx: TenantContext) {
    if (!ctx.can(PERMISSIONS.SALES_CREATE) && !ctx.can(PERMISSIONS.SALES_VIEW)) {
      throw ApiError.forbidden('You do not have permission to see held sales');
    }
    const rows = await ShopHeldSaleModel.find(this.scope(ctx)).sort({ createdAt: -1 }).limit(MAX_HOLDS_PER_BRANCH).lean();
    return rows.map((row) => ({
      _id: row._id,
      holdNumber: row.holdNumber,
      label: row.label,
      itemCount: row.items.length,
      /** What it came to when it was parked. The catalogue decides on resume. */
      estimatedTotalMinor: row.estimatedTotalMinor,
      customerName: row.customerDraft?.name ?? '',
      heldByNameSnapshot: row.heldByNameSnapshot,
      heldBy: row.heldBy,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }));
  }

  /**
   * Takes the basket back to the till, and removes the hold in the same breath.
   *
   * The lines come back RE-PRICED from the catalogue: a product that has since
   * changed price, been deactivated or been deleted is reported rather than
   * silently sold at the old figure.
   */
  async resume(ctx: TenantContext, id: Types.ObjectId) {
    if (!ctx.can(PERMISSIONS.SALES_CREATE)) throw ApiError.forbidden('You do not have permission to take a sale');

    // Atomic: two tills cannot both resume the same basket.
    const held = await ShopHeldSaleModel.findOneAndDelete({ _id: id, ...this.scope(ctx) }).lean();
    if (!held) throw ApiError.notFound('That held sale is no longer there. Someone else may have taken it, or it expired.');

    const products = await ShopProductModel.find({
      _id: { $in: held.items.map((item) => item.productId) },
      tenantId: ctx.tenantId,
      deletedAt: null,
    }).lean();

    // This branch's stock for those products, so the till can put the basket
    // back on screen without a second round trip.
    const stock = new Map(
      (await ShopStockModel.find({ tenantId: ctx.tenantId, storeId: ctx.storeId, productId: { $in: products.map((p) => p._id) } })
        .select('productId quantityOnHand costPriceMinor')
        .lean()).map((row) => [String(row.productId), { quantityOnHand: row.quantityOnHand, costPriceMinor: row.costPriceMinor }]),
    );

    const items = [];
    const dropped: string[] = [];

    for (const line of held.items) {
      const product = products.find((entry) => entry._id.equals(line.productId));
      if (!product) {
        dropped.push(line.nameSnapshot || 'a product that has since been removed');
        continue;
      }
      items.push({
        quantity: line.quantity,
        /** Today's catalogue entry, not the one from when it was parked. */
        product: { ...product, stock: stock.get(String(product._id)) ?? { quantityOnHand: 0, costPriceMinor: 0 } },
        /** True when the shelf price moved while the basket sat parked. */
        priceChanged: product.priceMinor !== line.unitPriceMinorSnapshot,
        pricedAtHoldMinor: line.unitPriceMinorSnapshot,
      });
    }

    return {
      holdNumber: held.holdNumber,
      label: held.label,
      items,
      /** Lines that no longer exist and could not come back. */
      dropped,
      customerId: held.customerId,
      customerDraft: held.customerDraft,
      discountMinor: held.discountMinor,
      loyaltyCardNumber: held.loyaltyCardNumber,
      note: held.note,
      heldByNameSnapshot: held.heldByNameSnapshot,
      createdAt: held.createdAt,
    };
  }

  /**
   * Throws a parked basket away.
   *
   * A cashier may always discard their own. Discarding somebody else's is a
   * supervisor's act, so it needs `sales.cancel` - the same permission that
   * voids a sale.
   */
  async remove(ctx: TenantContext, id: Types.ObjectId) {
    const held = await ShopHeldSaleModel.findOne({ _id: id, ...this.scope(ctx) }).select('heldBy holdNumber').lean();
    if (!held) throw ApiError.notFound('Held sale not found');

    const mine = String(held.heldBy) === String(ctx.userId);
    if (!mine && !ctx.can(PERMISSIONS.SALES_CANCEL)) {
      throw ApiError.forbidden("That held sale belongs to another cashier. You need permission to cancel a sale to discard it.");
    }
    await ShopHeldSaleModel.deleteOne({ _id: id, ...this.scope(ctx) });
    return { id: String(id), holdNumber: held.holdNumber };
  }
}

export const heldSaleService = new HeldSaleService();
