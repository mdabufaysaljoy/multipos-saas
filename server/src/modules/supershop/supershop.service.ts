import { Types } from 'mongoose';
import dayjs from 'dayjs';
import { PERMISSIONS } from '../../config/permissions';
import { CustomerModel } from '../../models/Customer';
import { ShopProductModel, type ShopProductDoc, type ShopUnitType } from '../../models/ShopProduct';
import { ShopSaleModel } from '../../models/ShopSale';
import { ShopStockModel, type ShopStockDoc } from '../../models/ShopStock';
import { ShopStockMovementModel, type ShopMovementType } from '../../models/ShopStockMovement';
import { StoreModel } from '../../models/Store';
import { loadReceiptStore } from '../../services/receipt/receiptStore';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { entitlementService } from '../../services/subscription/entitlement.service';
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

interface Taken {
  productId: Types.ObjectId;
  productName: string;
  unitType: ShopUnitType;
  quantity: number;
  balanceAfter: number;
  costPriceMinor: number;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (value: string) => new RegExp(`^${escapeRegex(value)}$`, 'i');
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;

// ---------------------------------------------------------------- money math
// All integer arithmetic. Weighed goods: price per kg, quantity in grams.

/** What a quantity costs at a unit price, rounded half-up to the minor unit. */
export const lineAmount = (unitPriceMinor: number, quantity: number, unitType: ShopUnitType): number =>
  unitType === 'weight' ? Math.floor((unitPriceMinor * quantity + 500) / 1000) : unitPriceMinor * quantity;

/** VAT contained in a VAT-inclusive amount at a rate in basis points, rounded half-up. */
export const includedVat = (grossMinor: number, rateBps: number): number =>
  rateBps <= 0 ? 0 : Math.floor((grossMinor * rateBps + Math.floor((10_000 + rateBps) / 2)) / (10_000 + rateBps));

/** "3" or "1.25 kg" - for messages. */
export const describeQuantity = (quantity: number, unitType: ShopUnitType) =>
  unitType === 'weight' ? `${(quantity / 1000).toFixed(3).replace(/\.?0+$/, '')} kg` : String(quantity);

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

  /** The scanner path: one exact barcode in this workspace, with this branch's stock. */
  async lookupBarcode(ctx: TenantContext, barcode: string) {
    const product = await ShopProductModel.findOne({ tenantId: ctx.tenantId, deletedAt: null, barcode }).lean<ProductRecord>();
    if (!product) throw ApiError.notFound('No product has that barcode');
    return this.withStock(product, await this.stockFor(ctx, [product._id]));
  }

  async categories(ctx: TenantContext) {
    const categories = await ShopProductModel.distinct('category', { tenantId: ctx.tenantId, deletedAt: null });
    return (categories as string[]).sort((a, b) => a.localeCompare(b));
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
    await this.assertUnique(ctx, values);
    const product = await ShopProductModel.create({ tenantId: ctx.tenantId, ...values, createdBy: ctx.userId });
    return product.toObject();
  }

  async updateProduct(ctx: TenantContext, id: Types.ObjectId, input: UpdateProductInput) {
    const before = await this.findProduct(ctx, id);
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
      this.movement(ctx, product, 'receive', input.quantity, stock.quantityOnHand, {
        unitCostMinor: input.costPriceMinor,
        reason: input.supplierName ? `Received from ${input.supplierName}` : 'Stock received',
      }),
    );
    return { ...stock, product: { _id: product._id, name: product.name, unitType: product.unitType } };
  }

  /** A counted correction or a write-off. Never below zero. */
  async adjustStock(ctx: TenantContext, productId: Types.ObjectId, input: AdjustStockInput) {
    const product = await this.findProduct(ctx, productId);
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
    await ShopStockMovementModel.create(this.movement(ctx, product, input.type, delta, updated.quantityOnHand, { reason: input.reason }));
    return { stock: updated, previousOnHand: updated.quantityOnHand - delta, product: { _id: product._id, name: product.name, unitType: product.unitType } };
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

  async createSale(ctx: TenantContext, input: CreateSaleInput) {
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
      const lineTotalMinor = lineAmount(product.priceMinor, item.quantity, product.unitType);
      if (!Number.isSafeInteger(lineTotalMinor)) throw ApiError.badRequest('That line is too large');
      return { product, quantity: item.quantity, lineTotalMinor, vatMinor: includedVat(lineTotalMinor, product.vatRateBps) };
    });

    // ---- money --------------------------------------------------------------
    const subtotalMinor = priced.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    if (input.discountMinor > 0 && !ctx.can(PERMISSIONS.SALES_DISCOUNT)) throw ApiError.forbidden('You do not have permission to give a discount');
    if (input.discountMinor > subtotalMinor) throw ApiError.badRequest('The discount cannot exceed the subtotal');

    const accepted = store.paymentMethods ?? [];
    const refused = input.payments.find((payment) => !accepted.includes(payment.method));
    if (refused) throw ApiError.badRequest(`This branch does not accept ${refused.method} payments`);

    const totalMinor = subtotalMinor - input.discountMinor;
    const paidMinor = input.payments.reduce((sum, payment) => sum + payment.amountMinor, 0);
    if (paidMinor < totalMinor) {
      throw ApiError.badRequest(`The payment is ${((totalMinor - paidMinor) / 100).toFixed(2)} short of the ${(totalMinor / 100).toFixed(2)} total.`, { totalMinor, paidMinor });
    }
    const changeMinor = paidMinor - totalMinor;
    const cashMinor = input.payments.filter((payment) => payment.method === 'cash').reduce((sum, payment) => sum + payment.amountMinor, 0);
    if (changeMinor > cashMinor) throw ApiError.badRequest('Only a cash payment can exceed the total');

    // VAT in what was actually charged: a sale discount reduces it proportionally.
    const lineVatMinor = priced.reduce((sum, line) => sum + line.vatMinor, 0);
    const vatMinor = subtotalMinor === 0 ? 0 : Math.floor((lineVatMinor * totalMinor + Math.floor(subtotalMinor / 2)) / subtotalMinor);

    let customerNameSnapshot = '';
    if (input.customerId) {
      const customer = await CustomerModel.findOne({ _id: input.customerId, tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null }).select('name').lean();
      if (!customer) throw ApiError.badRequest('That customer was not found');
      customerNameSnapshot = customer.name;
    }

    // ---- take stock ----------------------------------------------------------
    const taken: Taken[] = [];
    try {
      for (const line of priced) {
        const updated = await ShopStockModel.findOneAndUpdate(
          { tenantId: ctx.tenantId, storeId: ctx.storeId, productId: line.product._id, quantityOnHand: { $gte: line.quantity } },
          { $inc: { quantityOnHand: -line.quantity } },
          { new: true },
        ).lean<StockRecord>();
        if (!updated) {
          const stock = await ShopStockModel.findOne({ tenantId: ctx.tenantId, storeId: ctx.storeId, productId: line.product._id }).select('quantityOnHand').lean();
          throw ApiError.badRequest(`Only ${describeQuantity(stock?.quantityOnHand ?? 0, line.product.unitType)} of ${line.product.name} is in stock in this branch.`, {
            productId: line.product._id,
            available: stock?.quantityOnHand ?? 0,
          });
        }
        taken.push({
          productId: line.product._id,
          productName: line.product.name,
          unitType: line.product.unitType,
          quantity: line.quantity,
          balanceAfter: updated.quantityOnHand,
          costPriceMinor: updated.costPriceMinor,
        });
      }
    } catch (error) {
      await this.putBack(ctx, taken);
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
        const stockTaken = taken.find((entry) => entry.productId.equals(line.product._id))!;
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
          costMinor: lineAmount(stockTaken.costPriceMinor, line.quantity, line.product.unitType),
        };
      });

      const sale = await ShopSaleModel.create({
        _id: saleId,
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        saleNumber,
        items,
        subtotalMinor,
        discountMinor: input.discountMinor,
        totalMinor,
        vatMinor,
        costMinor: items.reduce((sum, line) => sum + line.costMinor, 0),
        paidMinor,
        changeMinor,
        payments: input.payments,
        customerId: input.customerId ?? null,
        customerNameSnapshot,
        note: input.note,
        status: 'completed',
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

      await ShopStockMovementModel.insertMany(
        taken.map((entry) =>
          this.movement(ctx, { _id: entry.productId, name: entry.productName, unitType: entry.unitType }, 'sale', -entry.quantity, entry.balanceAfter, {
            referenceId: saleId,
            referenceNumber: saleNumber,
          }),
        ),
      );
      return sale.toObject();
    } catch (error) {
      if (saved) await ShopSaleModel.deleteOne({ _id: saleId, tenantId: ctx.tenantId });
      await this.putBack(ctx, taken);
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
      filter.$or = [{ saleNumber: rx }, { 'items.nameSnapshot': rx }, { 'items.barcodeSnapshot': rx }];
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

    const movements = [];
    for (const line of sale.items) {
      const stock = await ShopStockModel.findOneAndUpdate(
        { tenantId: ctx.tenantId, storeId: ctx.storeId, productId: line.productId },
        { $inc: { quantityOnHand: line.quantity } },
        { new: true },
      ).lean<StockRecord>();
      if (stock) {
        movements.push(
          this.movement(ctx, { _id: line.productId, name: line.nameSnapshot, unitType: line.unitType }, 'void', line.quantity, stock.quantityOnHand, {
            reason,
            referenceId: sale._id,
            referenceNumber: sale.saleNumber,
          }),
        );
      }
    }
    if (movements.length > 0) await ShopStockMovementModel.insertMany(movements);
    return sale;
  }

  // =============================================================== dashboard

  async dashboard(ctx: TenantContext) {
    const startOfDay = dayjs().startOf('day').toDate();
    const startOfMonth = dayjs().startOf('month').toDate();
    const completed = { tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'completed' };
    const totals = (from: Date) =>
      ShopSaleModel.aggregate<{ count: number; totalMinor: number; vatMinor: number; costMinor: number }>([
        { $match: { ...completed, soldAt: { $gte: from } } },
        { $group: { _id: null, count: { $sum: 1 }, totalMinor: { $sum: '$totalMinor' }, vatMinor: { $sum: '$vatMinor' }, costMinor: { $sum: '$costMinor' } } },
      ]);

    const [todayRows, monthRows, topProducts, reorderable, stocked] = await Promise.all([
      totals(startOfDay),
      totals(startOfMonth),
      ShopSaleModel.aggregate<{ _id: Types.ObjectId; name: string; unitType: ShopUnitType; quantity: number; totalMinor: number }>([
        { $match: { ...completed, soldAt: { $gte: startOfDay } } },
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

    const summarise = (rows: { count: number; totalMinor: number; vatMinor: number; costMinor: number }[]) => ({
      salesCount: rows[0]?.count ?? 0,
      totalMinor: rows[0]?.totalMinor ?? 0,
      vatMinor: rows[0]?.vatMinor ?? 0,
      grossProfitMinor: (rows[0]?.totalMinor ?? 0) - (rows[0]?.vatMinor ?? 0) - (rows[0]?.costMinor ?? 0),
    });

    return {
      today: summarise(todayRows),
      month: summarise(monthRows),
      topProducts: topProducts.map((row) => ({ productId: row._id, name: row.name, unitType: row.unitType, quantity: row.quantity, totalMinor: row.totalMinor })),
      lowStock: lowStock.slice(0, 10),
      lowStockCount: lowStock.length,
    };
  }

  // ================================================================= helpers

  private async putBack(ctx: TenantContext, taken: Taken[]) {
    await Promise.all(
      taken.map((entry) => ShopStockModel.updateOne({ tenantId: ctx.tenantId, storeId: ctx.storeId, productId: entry.productId }, { $inc: { quantityOnHand: entry.quantity } })),
    );
    taken.length = 0;
  }

  private async stockFor(ctx: TenantContext, productIds: Types.ObjectId[]) {
    if (productIds.length === 0) return new Map<string, { quantityOnHand: number; costPriceMinor: number }>();
    const rows = await ShopStockModel.find({ tenantId: ctx.tenantId, storeId: ctx.storeId, productId: { $in: productIds } }).select('productId quantityOnHand costPriceMinor').lean();
    return new Map(rows.map((row) => [String(row.productId), { quantityOnHand: row.quantityOnHand, costPriceMinor: row.costPriceMinor }]));
  }

  private withStock(product: ProductRecord, stock: Map<string, { quantityOnHand: number; costPriceMinor: number }>) {
    return { ...product, stock: stock.get(String(product._id)) ?? { quantityOnHand: 0, costPriceMinor: 0 } };
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

  private movement(
    ctx: TenantContext,
    product: { _id: Types.ObjectId; name: string; unitType: string },
    type: ShopMovementType,
    quantity: number,
    balanceAfter: number,
    extra: { reason?: string; referenceId?: Types.ObjectId; referenceNumber?: string; unitCostMinor?: number } = {},
  ) {
    return {
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      productId: product._id,
      productNameSnapshot: product.name,
      unitType: product.unitType,
      type,
      quantity,
      balanceAfter,
      unitCostMinor: extra.unitCostMinor ?? null,
      reason: extra.reason ?? '',
      referenceId: extra.referenceId ?? null,
      referenceNumber: extra.referenceNumber ?? '',
      createdBy: ctx.userId,
      createdByNameSnapshot: ctx.userName,
    };
  }
}

export const supershopService = new SupershopService();
