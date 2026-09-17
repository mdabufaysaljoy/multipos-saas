import { Types } from 'mongoose';
import dayjs from 'dayjs';
import { INVENTORY_TX_TYPES, SALE_STATUS } from '../../config/constants';
import { PERMISSIONS } from '../../config/permissions';
import { ProductModel } from '../../models/Product';
import { ProductVariantModel } from '../../models/ProductVariant';
import { ReturnModel } from '../../models/Return';
import { SaleModel, type SaleItemDoc } from '../../models/Sale';
import { StoreModel } from '../../models/Store';
import { ApiError } from '../../utils/ApiError';
import { applyBasisPoints, clampDiscount } from '../../utils/money';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { inventoryService, type StockMovementResult } from '../../services/inventory/inventory.service';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { customerService } from '../customers/customers.service';
import type { TenantContext } from '../../types/express';
import type { CancelSaleInput, CreateSaleInput, ListSalesInput } from './sales.validators';

interface PricedLine {
  variantId: Types.ObjectId;
  productId: Types.ObjectId;
  productNameSnapshot: string;
  variantNameSnapshot: string;
  skuSnapshot: string;
  brandSnapshot: string;
  categoryId: Types.ObjectId | null;
  categoryNameSnapshot: string;
  unitPriceMinor: number;
  listPriceMinor: number;
  costPriceMinorSnapshot: number;
  quantity: number;
  lineTotalMinor: number;
}

class SaleService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, storeId: ctx.storeId };
  }

  /**
   * Completes a sale.
   *
   * Order of operations matters and is deliberate:
   *   1. validate + price every line from the DATABASE (client totals ignored)
   *   2. atomically decrement stock line by line
   *   3. persist the sale
   * If step 2 fails part-way, every decrement already applied is compensated,
   * so stock is never silently consumed by a sale that did not happen. If step
   * 3 fails, the same compensation runs.
   */
  async create(ctx: TenantContext, input: CreateSaleInput) {
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertUsable(entitlement);
    // Checked before any stock moves, so a rejected sale leaves nothing to undo.
    await entitlementService.assertCanRecordSale(ctx.tenantId, entitlement, 'clothing');

    const store = await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).lean();
    if (!store) throw ApiError.notFound('Store not found');

    if (!store.paymentMethods.includes(input.paymentMethod)) {
      throw ApiError.badRequest(`"${input.paymentMethod}" is not an enabled payment method for this store`);
    }

    const lines = await this.priceLines(ctx, input);
    const totals = this.computeTotals(lines, input, store.tax);

    const customer = await this.resolveCustomer(ctx, input);

    // ---- stock ------------------------------------------------------------
    const applied: StockMovementResult[] = [];
    try {
      for (const line of lines) {
        const movement = await inventoryService.decrease(ctx, line.variantId, line.quantity, {
          type: INVENTORY_TX_TYPES.SALE,
          reason: 'POS sale',
          referenceType: 'sale',
        });
        applied.push(movement);
      }
    } catch (error) {
      await inventoryService.compensate(ctx, applied, 'sale could not be completed');
      throw error;
    }

    // ---- persist ----------------------------------------------------------
    try {
      const seq = await nextSequence(ctx.tenantId, ctx.storeId, 'sale');
      const saleNumber = formatDocumentNumber(store.invoicePrefix, seq);
      const soldAt = new Date();

      const sale = await SaleModel.create({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        saleNumber,
        cashierId: ctx.userId,
        cashierNameSnapshot: ctx.userName,
        customerId: customer?._id ?? null,
        customerSnapshot: customer
          ? { name: customer.name, phone: customer.phone, email: customer.email ?? '' }
          : null,
        items: lines.map((line) => ({ ...line, lineDiscountMinor: 0, returnedQuantity: 0 })),
        subtotalMinor: totals.subtotalMinor,
        discountMinor: totals.discountMinor,
        discountType: input.discountType,
        discountValue: input.discountValue,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        paidMinor: totals.paidMinor,
        changeMinor: totals.changeMinor,
        paymentMethod: input.paymentMethod,
        payments: input.payments ?? [{ method: input.paymentMethod, amountMinor: totals.totalMinor, reference: '' }],
        paymentStatus: totals.paymentStatus,
        status: SALE_STATUS.COMPLETED,
        note: input.note,
        soldAt,
      });

      // The pre-flight allowance check is not atomic, so confirm by ordinal now
      // the sale exists. Racing tills each get a distinct position; any beyond
      // the monthly allowance undo themselves and the catch below puts the
      // stock back. The invoice sequence number is already spent, which leaves
      // a gap - preferable to selling past a limit the customer has not bought.
      const monthStart = dayjs(soldAt).startOf('month').toDate();
      const ordinal = await SaleModel.countDocuments({
        tenantId: ctx.tenantId,
        status: SALE_STATUS.COMPLETED,
        soldAt: { $gte: monthStart, $lte: soldAt },
        _id: { $lte: sale._id },
      });
      try {
        entitlementService.assertOrdinalWithinLimit(entitlement, 'maxMonthlySales', ordinal, 'sales per month');
      } catch (error) {
        await SaleModel.deleteOne({ _id: sale._id, tenantId: ctx.tenantId });
        throw error;
      }

      // Backfill the ledger rows with the invoice number now that it exists.
      await inventoryService.attachReference(ctx, applied, 'sale', sale._id, saleNumber);

      if (customer) {
        await customerService.applySaleStats(ctx, customer._id, {
          amountMinor: totals.totalMinor,
          orderDelta: 1,
          purchasedAt: soldAt,
        });
      }

      return sale.toObject();
    } catch (error) {
      await inventoryService.compensate(ctx, applied, 'sale record could not be saved');
      throw error;
    }
  }

  async list(ctx: TenantContext, input: ListSalesInput) {
    const { page, limit, skip } = resolvePage(input);
    // `allBranches` lets an owner see history from every branch, including any
    // that have since been deleted.
    const filter: Record<string, unknown> =
      input.allBranches && ctx.isAdmin ? { tenantId: ctx.tenantId } : { ...this.scope(ctx) };

    if (input.status) filter.status = input.status;
    if (input.cashierId) filter.cashierId = input.cashierId;
    if (input.customerId) filter.customerId = input.customerId;
    if (input.paymentMethod) filter.paymentMethod = input.paymentMethod;
    if (input.from || input.to) {
      filter.soldAt = {
        ...(input.from ? { $gte: input.from } : {}),
        ...(input.to ? { $lte: input.to } : {}),
      };
    }
    if (input.search) {
      const rx = searchRegex(input.search);
      filter.$or = [
        { saleNumber: rx },
        { 'customerSnapshot.name': rx },
        { 'customerSnapshot.phone': rx },
        { cashierNameSnapshot: rx },
      ];
    }

    const [items, total] = await Promise.all([
      SaleModel.find(filter).sort({ soldAt: input.order === 'asc' ? 1 : -1 }).skip(skip).limit(limit).lean(),
      SaleModel.countDocuments(filter),
    ]);

    return { items, page, limit, total };
  }

  /**
   * Reads a sale straight from its own stored snapshots. It deliberately does
   * not join to Product/Variant, which is what makes historical records immune
   * to later catalogue edits or deletions.
   */
  async getById(ctx: TenantContext, id: Types.ObjectId) {
    // Branch scoping applies to LISTS. For a direct lookup an administrator is
    // allowed tenant-wide access, otherwise sales made in a branch that has
    // since been deleted would become unreachable - and the requirement is that
    // historical business data stays auditable, not merely stored.
    const filter = ctx.isAdmin
      ? { _id: id, tenantId: ctx.tenantId }
      : { _id: id, ...this.scope(ctx) };

    const sale = await SaleModel.findOne(filter).lean();
    if (!sale) throw ApiError.notFound('Sale not found');
    return sale;
  }

  async getByNumber(ctx: TenantContext, saleNumber: string) {
    const filter = ctx.isAdmin ? { tenantId: ctx.tenantId } : this.scope(ctx);
    const sale = await SaleModel.findOne({ ...filter, saleNumber: saleNumber.trim().toUpperCase() }).lean();
    if (!sale) throw ApiError.notFound(`No sale found with number ${saleNumber}`);
    return sale;
  }

  /** Everything the 58mm receipt needs, in one call. */
  async getReceipt(ctx: TenantContext, id: Types.ObjectId) {
    const sale = await this.getById(ctx, id);

    // Reprint the branch the sale was actually made in - including a deleted
    // one - so an old receipt reproduces exactly as it was issued.
    const store =
      (await StoreModel.findOne({ _id: sale.storeId, tenantId: ctx.tenantId }).lean()) ??
      (await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).lean());

    if (!store) throw ApiError.notFound('Store not found');

    return {
      sale,
      store: {
        name: store.name,
        logoUrl: store.logoUrl,
        receiptLogoUrl: store.receiptLogoUrl,
        phone: store.phone,
        email: store.email,
        address: store.address,
        currency: store.currency,
        receipt: store.receipt,
        tax: store.tax,
      },
    };
  }

  /**
   * Voids a sale and returns the goods to stock. Blocked once any return has
   * been processed, because the two would otherwise both restore the same units.
   */
  async cancel(ctx: TenantContext, id: Types.ObjectId, input: CancelSaleInput) {
    const sale = await SaleModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!sale) throw ApiError.notFound('Sale not found');
    if (sale.status === SALE_STATUS.CANCELLED) throw ApiError.badRequest('This sale is already cancelled');

    const returnCount = await ReturnModel.countDocuments({ tenantId: ctx.tenantId, saleId: id });
    if (returnCount > 0) {
      throw ApiError.conflict('This sale has returns against it and can no longer be cancelled');
    }

    for (const item of sale.items) {
      await inventoryService.increase(ctx, item.variantId, item.quantity, {
        type: INVENTORY_TX_TYPES.SALE_CANCELLED,
        reason: input.reason,
        referenceType: 'sale',
        referenceId: sale._id,
        referenceNumber: sale.saleNumber,
      });
    }

    sale.status = SALE_STATUS.CANCELLED;
    sale.cancelledAt = new Date();
    sale.cancelledBy = ctx.userId;
    sale.note = sale.note ? `${sale.note}\nCancelled: ${input.reason}` : `Cancelled: ${input.reason}`;
    await sale.save();

    if (sale.customerId) {
      await customerService.applySaleStats(ctx, sale.customerId, {
        amountMinor: -sale.totalMinor,
        orderDelta: -1,
      });
    }

    return sale.toObject();
  }

  // ---------------------------------------------------------------- internals

  /**
   * Turns cart lines into priced, snapshotted sale lines using the CURRENT
   * database state. Nothing the client sends about names, prices or categories
   * is trusted; only variantId and quantity are taken at face value.
   */
  private async priceLines(ctx: TenantContext, input: CreateSaleInput): Promise<PricedLine[]> {
    const variantIds = input.items.map((item) => item.variantId);

    const variants = await ProductVariantModel.find({
      _id: { $in: variantIds },
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      deletedAt: null,
      isActive: true,
    }).lean();

    const variantById = new Map(variants.map((v) => [String(v._id), v]));

    const products = await ProductModel.find({
      _id: { $in: [...new Set(variants.map((v) => v.productId))] },
      tenantId: ctx.tenantId,
      deletedAt: null,
    })
      .select('_id name brand categoryId categoryNameSnapshot isActive')
      .lean();
    const productById = new Map(products.map((p) => [String(p._id), p]));

    const canChangePrice = ctx.can(PERMISSIONS.SALES_CHANGE_PRICE);

    return input.items.map((item, index) => {
      const variant = variantById.get(String(item.variantId));
      if (!variant) {
        throw ApiError.badRequest(`Item ${index + 1} is no longer available for sale`, { variantId: item.variantId });
      }

      const product = productById.get(String(variant.productId));
      if (!product || !product.isActive) {
        throw ApiError.badRequest(`"${variant.productNameSnapshot}" is no longer available for sale`, {
          variantId: item.variantId,
        });
      }

      // Defence in depth: the schema already rejects these, but a sale line is
      // the last place we want a bad number to slip through.
      if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
        throw ApiError.validation(`Quantity for "${variant.productNameSnapshot}" must be a whole number of at least 1`);
      }

      const listPriceMinor = variant.sellingPriceMinor;
      let unitPriceMinor = listPriceMinor;

      if (item.unitPriceMinor !== undefined && item.unitPriceMinor !== listPriceMinor) {
        // Price overrides are a permission-gated action, enforced here on the
        // server. Hiding the input on the frontend is a convenience, not a control.
        if (!canChangePrice) {
          throw ApiError.forbidden(
            `You do not have permission to change the price of "${variant.productNameSnapshot}"`,
          );
        }
        unitPriceMinor = item.unitPriceMinor;
      }

      if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor <= 0) {
        throw ApiError.validation(`Price for "${variant.productNameSnapshot}" must be greater than zero`);
      }

      return {
        variantId: variant._id,
        productId: variant.productId,
        productNameSnapshot: product.name,
        variantNameSnapshot: variant.name,
        skuSnapshot: variant.sku,
        brandSnapshot: product.brand,
        categoryId: product.categoryId,
        categoryNameSnapshot: product.categoryNameSnapshot || 'Uncategorised',
        unitPriceMinor,
        listPriceMinor,
        costPriceMinorSnapshot: variant.costPriceMinor,
        quantity: item.quantity,
        lineTotalMinor: unitPriceMinor * item.quantity,
      };
    });
  }

  /** All-integer money maths; no floats anywhere in this path. */
  private computeTotals(
    lines: PricedLine[],
    input: CreateSaleInput,
    tax: { enabled: boolean; rateBasisPoints: number; inclusive: boolean },
  ) {
    const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);

    let discountMinor = 0;
    if (input.discountType === 'fixed') discountMinor = input.discountValue;
    else if (input.discountType === 'percent') discountMinor = applyBasisPoints(subtotalMinor, input.discountValue);
    discountMinor = clampDiscount(discountMinor, subtotalMinor);

    const taxableMinor = subtotalMinor - discountMinor;
    // Inclusive tax is already inside the listed price, so it is reported but
    // not added again.
    const taxMinor = tax.enabled && !tax.inclusive ? applyBasisPoints(taxableMinor, tax.rateBasisPoints) : 0;

    const totalMinor = taxableMinor + taxMinor;
    if (totalMinor <= 0) {
      throw ApiError.validation('The sale total must be greater than zero');
    }

    // Payments, when supplied, are the source of truth for what was tendered.
    // Falling back to `paidMinor`, then to the total, keeps single-tender and
    // legacy callers working unchanged.
    const splitTotal = input.payments?.reduce((sum, payment) => sum + payment.amountMinor, 0);
    const paidMinor = splitTotal ?? input.paidMinor ?? totalMinor;

    // A sale cannot be completed for less than it costs. This is the backend
    // half of the tendered-amount rule; the POS blocks it too, but the server
    // is what actually enforces it.
    if (paidMinor < totalMinor) {
      throw ApiError.validation(
        `The amount tendered (${paidMinor}) is less than the total (${totalMinor}). Collect the full amount to complete this sale.`,
        { totalMinor, paidMinor, shortfallMinor: totalMinor - paidMinor },
      );
    }

    const changeMinor = paidMinor - totalMinor;

    return { subtotalMinor, discountMinor, taxMinor, totalMinor, paidMinor, changeMinor, paymentStatus: 'paid' };
  }

  private async resolveCustomer(ctx: TenantContext, input: CreateSaleInput) {
    if (input.customerId) return customerService.resolveForSale(ctx, input.customerId);
    if (input.customer) {
      if (!ctx.can(PERMISSIONS.CUSTOMERS_CREATE)) {
        throw ApiError.forbidden('You do not have permission to add customers');
      }
      return customerService.findOrCreateByPhone(ctx, input.customer);
    }
    // No customer supplied - that is a perfectly valid walk-in sale.
    return null;
  }
}

export type { SaleItemDoc };
export const saleService = new SaleService();
