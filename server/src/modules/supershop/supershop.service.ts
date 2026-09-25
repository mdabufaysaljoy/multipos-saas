import { Types } from 'mongoose';
import dayjs from 'dayjs';
import { PERMISSIONS } from '../../config/permissions';
import { ShopProductModel, type ShopProductDoc, type ShopUnitType } from '../../models/ShopProduct';
import { ShopSaleModel } from '../../models/ShopSale';
import { ShopStockModel, type ShopStockDoc } from '../../models/ShopStock';
import { ShopStockMovementModel } from '../../models/ShopStockMovement';
import { StoreModel } from '../../models/Store';
import { loadReceiptStore } from '../../services/receipt/receiptStore';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { customerService } from '../customers/customers.service';
import { posCategoryService } from '../../services/catalogue/posCategories.service';
import { loyaltyService } from '../loyalty/loyalty.service';
import { pointsForSpend } from '../loyalty/loyalty.math';
import { logger } from '../../utils/logger';
import { shopMovementRow, supershopInventoryAdapter, type ShopReservation } from '../../services/inventory/adapters/supershop.adapter';
import { POS_TENDER_DIALECT, settleTender, stampTenderLabels, tenderLabels } from '../../services/pos/paymentMethods.service';
import { resolveDashboardWindow } from '../reports/reports.service';
import { returnFiguresFor } from '../../services/returns/posReturns.figures';
import type { DashboardRangeInput } from '../reports/reports.validators';
import type { TenantContext } from '../../types/express';
import type {
  AdjustStockInput,
  CreateProductInput,
  CreateSaleInput,
  ListMovementsInput,
  ListProductsInput,
  ListSalesInput,
  ReceiveStockInput,
  UpdateProductInput,
} from './supershop.validators';

type ProductRecord = ShopProductDoc & { _id: Types.ObjectId };
type StockRecord = ShopStockDoc & { _id: Types.ObjectId };

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (value: string) => new RegExp(`^${escapeRegex(value)}$`, 'i');
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;

// The unit maths lives beside the model, so the inventory adapter can use it
// without importing this module.
import { describeMaxQuantity, describeQuantity, includedVat, lineAmount, maxQuantityFor } from '../../models/shopUnits';

export { describeQuantity, includedVat, lineAmount };

/**
 * Supershop POS.
 *
 * Built on the shared core like Restaurant and Pharmacy: tenant and branch come
 * from `ctx`, plan limits from the entitlement service (products against the
 * products limit, sales against the monthly limit), permissions reuse the
 * existing keys. What is specific to a supershop:
 *
 *   - goods sold by the piece or by weight (grams, priced per kg);
 *   - VAT-inclusive prices with a per-product rate, reported on every sale;
 *   - fast exact barcode lookup for scanners;
 *   - one stock record per product per branch with a weighted average cost;
 *   - every stock change in an append-only movement ledger.
 */
class SupershopService {
  // ================================================================ products

  async listProducts(ctx: TenantContext, input: ListProductsInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, deletedAt: null };
    if (input.activeOnly) filter.isActive = true;
    if (input.category) filter.category = input.category;
    if (input.brand) filter.brand = input.brand;
    if (input.search) {
      const rx = searchRegex(input.search);
      filter.$or = [{ name: rx }, { brand: rx }, { barcode: rx }];
    }
    if (input.lowStockOnly) {
      // Products at or below their reorder level in this branch (or with no stock record at all).
      const stocked = await ShopStockModel.find({ tenantId: ctx.tenantId, storeId: ctx.storeId }).select('productId quantityOnHand').lean();
      const onHand = new Map(stocked.map((row) => [String(row.productId), row.quantityOnHand]));
      const candidates = await ShopProductModel.find({ ...filter, reorderLevel: { $gt: 0 } }).select('_id reorderLevel').lean();
      filter._id = { $in: candidates.filter((p) => (onHand.get(String(p._id)) ?? 0) <= p.reorderLevel).map((p) => p._id) };
    }

    const [items, total] = await Promise.all([
      ShopProductModel.find(filter).sort({ category: 1, name: 1 }).skip(skip).limit(limit).lean<ProductRecord[]>(),
      ShopProductModel.countDocuments(filter),
    ]);
    const stock = await this.stockFor(ctx, items.map((item) => item._id));
    return { items: items.map((item) => this.withStock(item, stock)), page, limit, total };
  }

  /**
   * The brands this workspace actually sells under.
   *
   * A brand is free text on the product today (there is no Brand catalogue yet),
   * so the list is the distinct values in use rather than a managed set. Blanks
   * are dropped: "no brand" is not a brand to filter by. Sorted the way a person
   * reads a dropdown, and tenant-scoped like everything else.
   */
  async listBrands(ctx: TenantContext) {
    const brands = await ShopProductModel.distinct('brand', { tenantId: ctx.tenantId, deletedAt: null });
    return brands
      .filter((brand): brand is string => typeof brand === 'string' && brand.trim() !== '')
      .sort((a, b) => a.localeCompare(b));
  }

  /** The scanner path: one exact barcode in this workspace, with this branch's stock. */
  async lookupBarcode(ctx: TenantContext, barcode: string) {
    const product = await ShopProductModel.findOne({ tenantId: ctx.tenantId, deletedAt: null, barcode }).lean<ProductRecord>();
    if (!product) throw ApiError.notFound('No product has that barcode');
    return this.withStock(product, await this.stockFor(ctx, [product._id]));
  }

  async getProduct(ctx: TenantContext, id: Types.ObjectId) {
    const product = await this.findProduct(ctx, id);
    const [stock, movements] = await Promise.all([
      this.stockFor(ctx, [product._id]),
      ShopStockMovementModel.find({ tenantId: ctx.tenantId, storeId: ctx.storeId, productId: product._id }).sort({ createdAt: -1, _id: -1 }).limit(20).lean(),
    ]);
    return { product: this.withStock(product, stock), movements };
  }

  async createProduct(ctx: TenantContext, input: CreateProductInput) {
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    await entitlementService.assertCanAddProduct(ctx.tenantId, entitlement, 'supershop');
    const values = { ...input, category: input.category || 'General' };
    // A reorder level is a quantity too, so the same unit ceiling applies.
    this.assertWithinUnitMax(values.reorderLevel, { name: values.name, unitType: values.unitType }, 'reorder level');
    await this.assertUnique(ctx, values);
    // A department the shop has retired cannot take new goods; a new name joins
    // the catalogue so it can be managed like the rest.
    await posCategoryService.assertUsable(ctx, 'supershop', values.category);
    const product = await ShopProductModel.create({ tenantId: ctx.tenantId, ...values, createdBy: ctx.userId });
    return product.toObject();
  }

  async updateProduct(ctx: TenantContext, id: Types.ObjectId, input: UpdateProductInput) {
    const before = await this.findProduct(ctx, id);
    if (input.reorderLevel !== undefined) this.assertWithinUnitMax(input.reorderLevel, before, 'reorder level');
    if (input.category) await posCategoryService.assertUsable(ctx, 'supershop', input.category);
    await this.assertUnique(ctx, { name: input.name ?? before.name, brand: input.brand ?? before.brand, barcode: input.barcode ?? before.barcode }, id);
    const after = await ShopProductModel.findOneAndUpdate({ _id: id, tenantId: ctx.tenantId, deletedAt: null }, { $set: input }, { new: true, runValidators: true }).lean<ProductRecord>();
    if (!after) throw ApiError.notFound('Product not found');
    return { before, after };
  }

  /** Soft delete, refused while any branch still holds stock of it. */
  async removeProduct(ctx: TenantContext, id: Types.ObjectId) {
    const product = await this.findProduct(ctx, id);
    const [held] = await ShopStockModel.aggregate<{ quantity: number }>([
      { $match: { tenantId: ctx.tenantId, productId: product._id, quantityOnHand: { $gt: 0 } } },
      { $group: { _id: null, quantity: { $sum: '$quantityOnHand' } } },
    ]);
    if ((held?.quantity ?? 0) > 0) {
      throw ApiError.conflict(`${describeQuantity(held.quantity, product.unitType)} of ${product.name} is still in stock. Sell or write it off first.`);
    }
    await ShopProductModel.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { deletedAt: new Date(), isActive: false } });
    return { id };
  }

  // =================================================================== stock

  /**
   * Receives stock into this branch in one atomic update that also moves the
   * weighted average cost: (onHand × oldCost + received × newCost) ÷ newOnHand.
   */
  async receiveStock(ctx: TenantContext, productId: Types.ObjectId, input: ReceiveStockInput) {
    const product = await this.findProduct(ctx, productId);
    this.assertWithinUnitMax(input.quantity, product);
    const key = { tenantId: ctx.tenantId, storeId: ctx.storeId, productId: product._id };
    const receive = () =>
      ShopStockModel.findOneAndUpdate(
        key,
        [
          {
            $set: {
              costPriceMinor: {
                $let: {
                  vars: { onHand: { $max: [{ $ifNull: ['$quantityOnHand', 0] }, 0] }, cost: { $ifNull: ['$costPriceMinor', 0] } },
                  in: {
                    $round: [
                      { $divide: [{ $add: [{ $multiply: ['$$onHand', '$$cost'] }, input.quantity * input.costPriceMinor] }, { $add: ['$$onHand', input.quantity] }] },
                      0,
                    ],
                  },
                },
              },
              quantityOnHand: { $add: [{ $ifNull: ['$quantityOnHand', 0] }, input.quantity] },
              lastReceivedAt: '$$NOW',
              createdAt: { $ifNull: ['$createdAt', '$$NOW'] },
              updatedAt: '$$NOW',
            },
          },
        ] as never,
        { upsert: true, new: true },
      ).lean<StockRecord>();

    let stock: StockRecord | null;
    try {
      stock = await receive();
    } catch (error) {
      // Two first deliveries at once: the loser retries against the record the winner created.
      if (!isDuplicateKey(error)) throw error;
      stock = await receive();
    }
    if (!stock) throw ApiError.internal('Stock could not be recorded');

    await ShopStockMovementModel.create(
      shopMovementRow(ctx, product, 'receive', input.quantity, stock.quantityOnHand, {
        unitCostMinor: input.costPriceMinor,
        reason: input.supplierName ? `Received from ${input.supplierName}` : 'Stock received',
      }),
    );
    return { ...stock, product: { _id: product._id, name: product.name, unitType: product.unitType } };
  }

  /** A counted correction or a write-off. Never below zero. */
  async adjustStock(ctx: TenantContext, productId: Types.ObjectId, input: AdjustStockInput) {
    const product = await this.findProduct(ctx, productId);
    this.assertWithinUnitMax(input.quantityDelta, product, 'change');
    const delta = input.quantityDelta;
    const updated = await ShopStockModel.findOneAndUpdate(
      { tenantId: ctx.tenantId, storeId: ctx.storeId, productId: product._id, ...(delta < 0 ? { quantityOnHand: { $gte: -delta } } : {}) },
      { $inc: { quantityOnHand: delta } },
      { new: true },
    ).lean<StockRecord>();
    if (!updated) {
      const stock = await ShopStockModel.findOne({ tenantId: ctx.tenantId, storeId: ctx.storeId, productId: product._id }).lean();
      if (!stock) throw ApiError.badRequest(`${product.name} has no stock in this branch yet. Receive stock first.`);
      throw ApiError.badRequest(`Only ${describeQuantity(stock.quantityOnHand, product.unitType)} of ${product.name} is on hand.`);
    }
    await ShopStockMovementModel.create(shopMovementRow(ctx, product, input.type, delta, updated.quantityOnHand, { reason: input.reason }));
    return { stock: updated, previousOnHand: updated.quantityOnHand - delta, product: { _id: product._id, name: product.name, unitType: product.unitType } };
  }

  /**
   * What the shelf is worth in this branch, in one aggregate.
   *
   * Counted from the catalogue, not from the stock rows, so a product that has
   * never been received still counts as out of stock. Weighed goods keep their
   * cost per kilogram against a quantity in grams, which is why the value is
   * divided by 1,000 for them. Stock below zero (an authorised out-of-stock
   * sale) is worth nothing rather than cancelling another product out.
   */
  async inventorySummary(ctx: TenantContext) {
    const perUnit = (price: string) => ({
      $floor: {
        $divide: [
          { $multiply: [{ $max: ['$onHand', 0] }, price] },
          { $cond: [{ $eq: ['$unitType', 'weight'] }, 1000, 1] },
        ],
      },
    });

    const [totals] = await ShopProductModel.aggregate<{
      productCount: number;
      stockValueMinor: number;
      retailValueMinor: number;
      outOfStock: number;
      lowStock: number;
    }>([
      { $match: { tenantId: ctx.tenantId, deletedAt: null } },
      {
        $lookup: {
          from: ShopStockModel.collection.name,
          let: { productId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$productId', '$$productId'] }, tenantId: ctx.tenantId, storeId: ctx.storeId } },
            { $project: { quantityOnHand: 1, costPriceMinor: 1 } },
          ],
          as: 'stock',
        },
      },
      {
        $addFields: {
          onHand: { $ifNull: [{ $arrayElemAt: ['$stock.quantityOnHand', 0] }, 0] },
          costPriceMinor: { $ifNull: [{ $arrayElemAt: ['$stock.costPriceMinor', 0] }, 0] },
        },
      },
      {
        $group: {
          _id: null,
          productCount: { $sum: 1 },
          stockValueMinor: { $sum: perUnit('$costPriceMinor') },
          retailValueMinor: { $sum: perUnit('$priceMinor') },
          outOfStock: { $sum: { $cond: [{ $lte: ['$onHand', 0] }, 1, 0] } },
          lowStock: {
            $sum: {
              $cond: [{ $and: [{ $gt: ['$reorderLevel', 0] }, { $gt: ['$onHand', 0] }, { $lte: ['$onHand', '$reorderLevel'] }] }, 1, 0],
            },
          },
        },
      },
    ]);

    return {
      productCount: totals?.productCount ?? 0,
      stockValueMinor: totals?.stockValueMinor ?? 0,
      retailValueMinor: totals?.retailValueMinor ?? 0,
      outOfStock: totals?.outOfStock ?? 0,
      lowStock: totals?.lowStock ?? 0,
    };
  }

  async listMovements(ctx: TenantContext, input: ListMovementsInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, storeId: ctx.storeId };
    if (input.productId) filter.productId = input.productId;
    const [items, total] = await Promise.all([
      ShopStockMovementModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      ShopStockMovementModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  // =================================================================== sales

  /**
   * A till sale, and the replacement side of an exchange.
   *
   * `options.exchange` is INTERNAL - it is never reachable from a request body.
   * When it is present the returned goods' refund value has already been earned
   * by the customer, so it pays for part of this basket: the tenders only have
   * to cover what is left. Everything else - pricing, VAT, stock, the ledger,
   * the customer's lifetime value - follows the ordinary rules, which is the
   * point of routing an exchange through here instead of writing a second
   * checkout.
   */
  async createSale(
    ctx: TenantContext,
    input: CreateSaleInput,
    options: {
      exchange?: {
        originalSaleId: Types.ObjectId;
        originalSaleNumber: string;
        creditMinor: number;
        returnedItems: { nameSnapshot: string; detailSnapshot: string; quantity: number; unitType: string; lineTotalMinor: number }[];
      };
    } = {},
  ) {
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertUsable(entitlement);
    await entitlementService.assertCanRecordSale(ctx.tenantId, entitlement, 'supershop');

    const store = await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).select('paymentMethods invoicePrefix').lean();
    if (!store) throw ApiError.notFound('Branch not found');

    // ---- price from the catalogue -----------------------------------------
    const products = await ShopProductModel.find({ _id: { $in: input.items.map((item) => item.productId) }, tenantId: ctx.tenantId, deletedAt: null }).lean<ProductRecord[]>();
    const priced = input.items.map((item) => {
      const product = products.find((entry) => entry._id.equals(item.productId));
      if (!product) throw ApiError.badRequest('One of the items is not in this shop');
      if (!product.isActive) throw ApiError.badRequest(`${product.name} is not for sale right now`);
      this.assertWithinUnitMax(item.quantity, product);
      const lineTotalMinor = lineAmount(product.priceMinor, item.quantity, product.unitType);
      if (!Number.isSafeInteger(lineTotalMinor)) throw ApiError.badRequest('That line is too large');
      return { product, quantity: item.quantity, lineTotalMinor, vatMinor: includedVat(lineTotalMinor, product.vatRateBps) };
    });

    // ---- money --------------------------------------------------------------
    const subtotalMinor = priced.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    if (input.discountMinor > 0 && !ctx.can(PERMISSIONS.SALES_DISCOUNT)) throw ApiError.forbidden('You do not have permission to give a discount');
    if (input.discountMinor > subtotalMinor) throw ApiError.badRequest('The discount cannot exceed the subtotal');

    // ---- loyalty -------------------------------------------------------------
    // Only a scanned card earns or redeems; a customer on the sale does not.
    const loyalty = await loyaltyService.prepareForSale(ctx, {
      membershipId: input.loyaltyMembershipId,
      redeemPoints: input.redeemPoints,
      internal: false,
    });
    if (loyalty && input.customerId && !loyalty.membership.customerId.equals(input.customerId)) {
      throw ApiError.validation('The loyalty card belongs to a different customer. Remove the customer or the card.');
    }
    const loyaltyDiscountMinor = loyalty ? input.redeemPoints * loyalty.settings.pointValueMinor : 0;
    if (loyaltyDiscountMinor > subtotalMinor - input.discountMinor) {
      throw ApiError.validation('Those points are worth more than this basket.', { reason: 'LOYALTY_DISCOUNT_TOO_LARGE' });
    }

    const totalMinor = subtotalMinor - input.discountMinor - loyaltyDiscountMinor;
    if (totalMinor <= 0) {
      throw ApiError.validation('A basket must come to more than nothing after points.', { reason: 'LOYALTY_NOTHING_PAYABLE' });
    }
    // An exchange credit is money the customer has already handed over once, on
    // the sale being returned. It pays for this basket before any tender does.
    const creditMinor = options.exchange?.creditMinor ?? 0;
    if (creditMinor > totalMinor) {
      // The caller checks this first; this is the backstop that keeps a credit
      // from ever turning into cash out of the drawer.
      throw ApiError.validation('The exchange credit is worth more than the replacement basket.', { reason: 'EXCHANGE_CREDIT_EXCEEDS_TOTAL' });
    }
    const payableMinor = totalMinor - creditMinor;

    // Enabled for the branch, covering what is still payable, change only out of
    // cash: the same three rules every POS settles by.
    const { paidMinor, changeMinor } = settleTender({
      totalMinor: payableMinor,
      tendered: input.payments,
      accepted: store.paymentMethods ?? [],
      dialect: POS_TENDER_DIALECT,
    });
    // Each row keeps the name the workspace uses for that method today.
    const paidWith = stampTenderLabels(input.payments, await tenderLabels(ctx.tenantId));

    // VAT in what was actually charged: a sale discount reduces it proportionally.
    const lineVatMinor = priced.reduce((sum, line) => sum + line.vatMinor, 0);
    const vatMinor = subtotalMinor === 0 ? 0 : Math.floor((lineVatMinor * totalMinor + Math.floor(subtotalMinor / 2)) / subtotalMinor);

    // Optional, and resolved the same way in every vertical: an existing
    // customer, or one created at the till from a name and phone.
    const customer = await customerService.resolveForPosSale(ctx, input);

    // Names the redemption before the sale exists, so the ledger row can be
    // stamped with the invoice number once it does.
    const checkoutRef = new Types.ObjectId();
    let redeemed: { balanceAfter: number } | null = null;
    if (loyalty && input.redeemPoints > 0) {
      redeemed = await loyaltyService.redeemForSale(ctx, loyalty.membership._id, input.redeemPoints, checkoutRef);
    }
    const undoRedemption = async () => {
      if (loyalty && redeemed) await loyaltyService.reverseRedemption(ctx, loyalty.membership._id, input.redeemPoints, checkoutRef);
    };

    // ---- take stock ----------------------------------------------------------
    // Through the adapter, so shared code can do this without knowing that a
    // Super Shop keeps one stock row per product per branch.
    // From the permissions resolved for THIS request, never from the client.
    const allowOutOfStock = ctx.can(PERMISSIONS.SALES_SELL_OUT_OF_STOCK);
    const taken: ShopReservation[] = [];
    try {
      for (const line of priced) {
        const reservation = await supershopInventoryAdapter.reserve(ctx, {
          itemId: line.product._id,
          quantity: line.quantity,
          label: line.product.name,
          allowOutOfStock,
        });
        reservation.detail.unitType = line.product.unitType;
        taken.push(reservation);
      }
    } catch (error) {
      await supershopInventoryAdapter.release(ctx, taken);
      await undoRedemption();
      throw error;
    }

    // ---- persist ---------------------------------------------------------------
    const saleId = new Types.ObjectId();
    let saved = false;
    try {
      const seq = await nextSequence(ctx.tenantId, ctx.storeId, 'supershop-sale');
      const saleNumber = formatDocumentNumber(store.invoicePrefix || 'SS-', seq);
      const soldAt = new Date();
      const items = priced.map((line) => {
        const stockTaken = taken.find((entry) => entry.itemId.equals(line.product._id))!;
        return {
          _id: new Types.ObjectId(),
          productId: line.product._id,
          nameSnapshot: line.product.name,
          brandSnapshot: line.product.brand,
          barcodeSnapshot: line.product.barcode,
          categorySnapshot: line.product.category,
          unitType: line.product.unitType,
          unitPriceMinor: line.product.priceMinor,
          quantity: line.quantity,
          lineTotalMinor: line.lineTotalMinor,
          vatRateBps: line.product.vatRateBps,
          vatMinor: line.vatMinor,
          costMinor: lineAmount(stockTaken.detail.costPriceMinor, line.quantity, line.product.unitType),
          ...(stockTaken.detail.outOfStockOverride ? { outOfStockOverride: true } : {}),
        };
      });

      const sale = await ShopSaleModel.create({
        _id: saleId,
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        saleNumber,
        items,
        subtotalMinor,
        // Includes the loyalty discount, so every report that subtracts discounts stays right.
        discountMinor: input.discountMinor + loyaltyDiscountMinor,
        totalMinor,
        vatMinor,
        costMinor: items.reduce((sum, line) => sum + line.costMinor, 0),
        paidMinor,
        changeMinor,
        payments: paidWith,
        customerId: customer?._id ?? null,
        customerNameSnapshot: customer?.name ?? '',
        loyalty: loyalty
          ? {
              membershipId: loyalty.membership._id,
              cardNumber: loyalty.membership.cardNumber,
              pointValueMinor: loyalty.settings.pointValueMinor,
              earnSpendMinor: loyalty.settings.earnSpendMinor,
              pointsRedeemed: input.redeemPoints,
              discountMinor: loyaltyDiscountMinor,
              // VAT never earns points: it is collected for the government.
              qualifyingMinor: Math.max(0, totalMinor - vatMinor),
              pointsEarned: 0,
              balanceAfter: redeemed?.balanceAfter ?? loyalty.membership.pointsBalance,
              pointsEarnedReversed: 0,
              pointsRedeemedRestored: 0,
            }
          : null,
        note: input.note,
        status: 'completed',
        ...(options.exchange
          ? {
              exchange: {
                returnId: null,
                returnNumber: '',
                originalSaleId: options.exchange.originalSaleId,
                originalSaleNumber: options.exchange.originalSaleNumber,
                creditMinor,
                returnedItems: options.exchange.returnedItems,
              },
            }
          : {}),
        soldAt,
        cashierId: ctx.userId,
        cashierNameSnapshot: ctx.userName,
      });
      saved = true;

      // Monthly allowance confirmed by ordinal, ordered by id only (race-safe).
      const ordinal = await ShopSaleModel.countDocuments({
        tenantId: ctx.tenantId,
        status: 'completed',
        soldAt: { $gte: dayjs(soldAt).startOf('month').toDate() },
        _id: { $lte: saleId },
      });
      entitlementService.assertOrdinalWithinLimit(entitlement, 'maxMonthlySales', ordinal, 'sales per month');

      await supershopInventoryAdapter.commit(ctx, taken, { referenceId: saleId, referenceNumber: saleNumber });
      if (customer) {
        await customerService.applySaleStats(ctx, customer._id, { amountMinor: totalMinor, orderDelta: 1, purchasedAt: soldAt });
      }

      // ---- earning: only now the sale is complete, and only once ------------
      if (loyalty) {
        await loyaltyService.attachSale(ctx, checkoutRef, sale._id, saleNumber);
        try {
          const points = pointsForSpend(Math.max(0, totalMinor - vatMinor), loyalty.settings.earnSpendMinor);
          const earned = await loyaltyService.earnForSale(ctx, loyalty.membership._id, points, { _id: sale._id, saleNumber });
          if (earned && sale.loyalty) {
            sale.loyalty.pointsEarned = points;
            sale.loyalty.balanceAfter = earned.balanceAfter;
            await ShopSaleModel.updateOne(
              { _id: sale._id, tenantId: ctx.tenantId },
              { $set: { 'loyalty.pointsEarned': points, 'loyalty.balanceAfter': earned.balanceAfter } },
            );
          }
        } catch (error) {
          // The customer has paid and the sale stands; the missing points are
          // logged for a manual adjustment rather than failing the sale.
          logger.error('CRITICAL: loyalty points could not be awarded for a completed Super Shop sale', {
            tenantId: String(ctx.tenantId),
            saleId: String(sale._id),
            error,
          });
        }
      }

      return sale.toObject();
    } catch (error) {
      if (saved) await ShopSaleModel.deleteOne({ _id: saleId, tenantId: ctx.tenantId });
      await supershopInventoryAdapter.release(ctx, taken);
      await undoRedemption();
      throw error;
    }
  }

  async listSales(ctx: TenantContext, input: ListSalesInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, storeId: ctx.storeId };
    if (input.status) filter.status = input.status;
    if (input.from || input.to) {
      filter.soldAt = {
        ...(input.from ? { $gte: dayjs(input.from).startOf('day').toDate() } : {}),
        ...(input.to ? { $lte: dayjs(input.to).endOf('day').toDate() } : {}),
      };
    }
    if (input.search) {
      const rx = searchRegex(input.search);
      filter.$or = [{ saleNumber: rx }, { 'items.nameSnapshot': rx }, { 'items.barcodeSnapshot': rx }, { customerNameSnapshot: rx }];
    }
    const [items, total] = await Promise.all([
      ShopSaleModel.find(filter).sort({ soldAt: -1 }).skip(skip).limit(limit).lean(),
      ShopSaleModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  async getSale(ctx: TenantContext, id: Types.ObjectId) {
    const sale = await ShopSaleModel.findOne({ _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId }).lean();
    if (!sale) throw ApiError.notFound('Sale not found');
    return sale;
  }

  async receipt(ctx: TenantContext, id: Types.ObjectId) {
    const sale = await this.getSale(ctx, id);
    // The shared receipt branch: header, logo, footer and the configured paper
    // width, so this receipt prints like every other vertical's.
    const store = await loadReceiptStore(ctx.tenantId, ctx.storeId, sale.storeId);
    return { sale, store };
  }

  /** Voids a completed sale and returns every item to this branch's stock. Final. */
  async voidSale(ctx: TenantContext, id: Types.ObjectId, reason: string) {
    const sale = await ShopSaleModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'completed' },
      { $set: { status: 'voided', voidedAt: new Date(), voidedBy: ctx.userId, voidedByNameSnapshot: ctx.userName, voidReason: reason } },
      { new: true },
    ).lean();
    if (!sale) {
      await this.getSale(ctx, id);
      throw ApiError.conflict('This sale has already been voided');
    }

    // The sale happened, so putting the goods back is a movement of its own.
    await supershopInventoryAdapter.restore(
      ctx,
      sale.items.map((line) => ({
        itemId: line.productId,
        quantity: line.quantity,
        balanceAfter: 0,
        detail: { productName: line.nameSnapshot, unitType: line.unitType, costPriceMinor: 0 },
      })),
      { reason, referenceId: sale._id, referenceNumber: sale.saleNumber },
    );

    // A voided sale never happened as far as the card is concerned: points it
    // earned are taken back and points it spent are given back.
    if (sale.loyalty) {
      await loyaltyService.applyCancellation(
        ctx,
        { _id: sale._id, saleNumber: sale.saleNumber, loyalty: sale.loyalty as never },
        reason,
        ShopSaleModel as never,
      );
    }

    // A voided sale is not a purchase: take it back off the customer's total.
    if (sale.customerId) {
      await customerService.applySaleStats(ctx, sale.customerId, { amountMinor: -sale.totalMinor, orderDelta: -1 });
    }

    return sale;
  }

  // =============================================================== dashboard

  /**
   * The Super Shop dashboard for the current branch.
   *
   * Trading figures cover the chosen range and are compared with the period of
   * equal length just before it. What needs reordering is always "right now",
   * whatever range is chosen: it describes the shelf, not a period.
   *
   * Gross profit is net sales less VAT less cost of goods - VAT is collected
   * for the government, not earned - the same definition Advanced Analytics uses.
   */
  async dashboard(ctx: TenantContext, input: DashboardRangeInput) {
    const { bucket, previousFrom, previousTo, ...range } = resolveDashboardWindow(input);
    const completed = { tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'completed' };
    const soldIn = (from: Date, to: Date) => ({ ...completed, soldAt: { $gte: from, $lte: to } });
    const totals = (from: Date, to: Date) =>
      ShopSaleModel.aggregate<{ count: number; totalMinor: number; vatMinor: number; costMinor: number; discountMinor: number }>([
        { $match: soldIn(from, to) },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            totalMinor: { $sum: '$totalMinor' },
            vatMinor: { $sum: '$vatMinor' },
            costMinor: { $sum: '$costMinor' },
            discountMinor: { $sum: '$discountMinor' },
          },
        },
      ]);

    const [currentRows, previousRows, refunds, topProducts, reorderable, stocked] = await Promise.all([
      totals(range.from, range.to),
      totals(previousFrom, previousTo),
      // What was charged is on the sales; what was kept is that less refunds.
      returnFiguresFor(ctx, 'supershop', { from: range.from, to: range.to }),
      ShopSaleModel.aggregate<{ _id: Types.ObjectId; name: string; unitType: ShopUnitType; quantity: number; totalMinor: number }>([
        { $match: soldIn(range.from, range.to) },
        { $unwind: '$items' },
        { $group: { _id: '$items.productId', name: { $last: '$items.nameSnapshot' }, unitType: { $last: '$items.unitType' }, quantity: { $sum: '$items.quantity' }, totalMinor: { $sum: '$items.lineTotalMinor' } } },
        { $sort: { totalMinor: -1 } },
        { $limit: 5 },
      ]),
      ShopProductModel.find({ tenantId: ctx.tenantId, deletedAt: null, isActive: true, reorderLevel: { $gt: 0 } }).select('name unitType reorderLevel').limit(1000).lean<ProductRecord[]>(),
      ShopStockModel.find({ tenantId: ctx.tenantId, storeId: ctx.storeId }).select('productId quantityOnHand').lean(),
    ]);

    const onHand = new Map(stocked.map((row) => [String(row.productId), row.quantityOnHand]));
    const lowStock = reorderable
      .map((product) => ({
        productId: product._id,
        name: product.name,
        unitType: product.unitType,
        reorderLevel: product.reorderLevel,
        quantityOnHand: onHand.get(String(product._id)) ?? 0,
      }))
      .filter((row) => row.quantityOnHand <= row.reorderLevel)
      .sort((a, b) => a.quantityOnHand / a.reorderLevel - b.quantityOnHand / b.reorderLevel);

    const summarise = (rows: { count: number; totalMinor: number; vatMinor: number; costMinor: number; discountMinor: number }[]) => {
      const row = rows[0];
      const salesCount = row?.count ?? 0;
      const totalMinor = row?.totalMinor ?? 0;
      return {
        salesCount,
        totalMinor,
        vatMinor: row?.vatMinor ?? 0,
        discountMinor: row?.discountMinor ?? 0,
        grossProfitMinor: totalMinor - (row?.vatMinor ?? 0) - (row?.costMinor ?? 0),
        averageSaleMinor: salesCount > 0 ? Math.round(totalMinor / salesCount) : 0,
      };
    };

    const current = summarise(currentRows);
    return {
      range: { from: range.from, to: range.to, label: range.label, preset: range.preset, bucket },
      kpis: {
        ...current,
        refundCount: refunds.count,
        refundedMinor: refunds.totalMinor,
        // What the till actually kept: charged less refunded.
        netSalesMinor: current.totalMinor - refunds.totalMinor,
        // Profit on what was kept, with the cost of returned goods taken back
        // out - the same arithmetic Advanced Analytics uses, so the two agree.
        grossProfitMinor: current.grossProfitMinor - refunds.totalMinor + refunds.costMinor,
      },
      previous: summarise(previousRows),
      topProducts: topProducts.map((row) => ({ productId: row._id, name: row.name, unitType: row.unitType, quantity: row.quantity, totalMinor: row.totalMinor })),
      lowStock: lowStock.slice(0, 10),
      lowStockCount: lowStock.length,
    };
  }

  // ================================================================= helpers

  private async stockFor(ctx: TenantContext, productIds: Types.ObjectId[]) {
    if (productIds.length === 0) return new Map<string, { quantityOnHand: number; costPriceMinor: number }>();
    const rows = await ShopStockModel.find({ tenantId: ctx.tenantId, storeId: ctx.storeId, productId: { $in: productIds } }).select('productId quantityOnHand costPriceMinor').lean();
    return new Map(rows.map((row) => [String(row.productId), { quantityOnHand: row.quantityOnHand, costPriceMinor: row.costPriceMinor }]));
  }

  private withStock(product: ProductRecord, stock: Map<string, { quantityOnHand: number; costPriceMinor: number }>) {
    return { ...product, stock: stock.get(String(product._id)) ?? { quantityOnHand: 0, costPriceMinor: 0 } };
  }

  /**
   * The quantity ceiling that actually applies to this product.
   *
   * The schema bounds every quantity by the widest any unit type allows,
   * because it cannot see the product. Pieces are capped lower than grams, so
   * the real limit is applied here, where `unitType` is known - and reported in
   * the unit the person typed, not in grams.
   */
  private assertWithinUnitMax(quantity: number, product: { name: string; unitType: ShopUnitType }, what = 'quantity') {
    if (Math.abs(quantity) > maxQuantityFor(product.unitType)) {
      throw ApiError.badRequest(
        `That ${what} is too large for ${product.name}. The most in one go is ${describeMaxQuantity(product.unitType)}.`,
        { max: maxQuantityFor(product.unitType), unitType: product.unitType },
      );
    }
  }

  private async findProduct(ctx: TenantContext, id: Types.ObjectId) {
    const product = await ShopProductModel.findOne({ _id: id, tenantId: ctx.tenantId, deletedAt: null }).lean<ProductRecord>();
    if (!product) throw ApiError.notFound('Product not found');
    return product;
  }

  /** The same name and brand is one product; a barcode belongs to one product. */
  private async assertUnique(ctx: TenantContext, identity: { name: string; brand: string; barcode: string }, exceptId?: Types.ObjectId) {
    const except = exceptId ? { _id: { $ne: exceptId } } : {};
    if (await ShopProductModel.exists({ tenantId: ctx.tenantId, deletedAt: null, name: exact(identity.name), brand: exact(identity.brand), ...except })) {
      throw ApiError.conflict('A product with this name and brand already exists');
    }
    if (identity.barcode && (await ShopProductModel.exists({ tenantId: ctx.tenantId, deletedAt: null, barcode: identity.barcode, ...except }))) {
      throw ApiError.conflict('Another product already uses this barcode');
    }
  }


}

export const supershopService = new SupershopService();
