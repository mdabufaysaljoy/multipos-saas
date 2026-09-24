import { Types } from 'mongoose';
import dayjs from 'dayjs';
import { INVENTORY_TX_TYPES, SALE_STATUS } from '../../config/constants';
import { PERMISSIONS } from '../../config/permissions';
import { ProductModel } from '../../models/Product';
import { ProductVariantModel } from '../../models/ProductVariant';
import { ReturnModel } from '../../models/Return';
import { SaleModel, type SaleExchange, type SaleItemDoc } from '../../models/Sale';
import { StoreModel } from '../../models/Store';
import { ApiError } from '../../utils/ApiError';
import { applyBasisPoints, clampDiscount } from '../../utils/money';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { inventoryService, type StockMovementResult } from '../../services/inventory/inventory.service';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { customerService } from '../customers/customers.service';
import { pointsForSpend } from '../loyalty/loyalty.math';
import { loyaltyService } from '../loyalty/loyalty.service';
import { logger } from '../../utils/logger';
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

/** Server-side options for creating the replacement sale of an exchange. Never read from a request. */
export interface SaleExchangeOptions {
  exchange?: { creditMinor: number; returnedItems: SaleExchange['returnedItems'] };
  /** The original sale's loyalty card, so an exchange's replacement goods earn points. Server-side only. */
  loyaltyMembershipId?: Types.ObjectId;
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
  async create(ctx: TenantContext, input: CreateSaleInput, options: SaleExchangeOptions = {}) {
    // A retried checkout (double click, refresh, network retry) returns the sale
    // it already created instead of selling - and awarding points - twice.
    if (input.idempotencyKey) {
      const existing = await SaleModel.findOne({ ...this.scope(ctx), idempotencyKey: input.idempotencyKey }).lean();
      if (existing) return { ...existing, replayed: true };
    }

    const creditMinor = options.exchange?.creditMinor ?? 0;
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertUsable(entitlement);
    // Checked before any stock moves, so a rejected sale leaves nothing to undo.
    await entitlementService.assertCanRecordSale(ctx.tenantId, entitlement, 'clothing');

    const store = await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).lean();
    if (!store) throw ApiError.notFound('Store not found');

    // Loyalty applies only to a scanned card (or, for an exchange, the original
    // sale's card) - never to a customer or phone number on its own.
    const redeemPoints = input.redeemPoints ?? 0;
    const loyalty = await loyaltyService.prepareForSale(ctx, {
      membershipId: input.loyaltyMembershipId ?? options.loyaltyMembershipId,
      redeemPoints,
      internal: !input.loyaltyMembershipId && Boolean(options.loyaltyMembershipId),
    });
    if (loyalty) {
      const cardCustomerId = String(loyalty.membership.customerId);
      if (input.customer || (input.customerId && String(input.customerId) !== cardCustomerId)) {
        throw ApiError.validation('The loyalty card belongs to a different customer. Remove the customer or the card.');
      }
    }
    const loyaltyDiscountMinor = loyalty ? redeemPoints * loyalty.settings.pointValueMinor : 0;

    const lines = await this.priceLines(ctx, input);
    const totals = this.computeTotals(lines, input, store.tax, creditMinor, loyaltyDiscountMinor);

    // Every method that actually takes money must be enabled for the store.
    // An exchange fully covered by its credit, or a sale fully paid with points, takes no money at all.
    const takesNoMoney = loyaltyDiscountMinor > 0 && totals.totalMinor === 0;
    const methodsUsed = input.payments?.length
      ? input.payments.map((payment) => payment.method)
      : creditMinor > 0 || takesNoMoney
        ? []
        : [input.paymentMethod];
    for (const method of methodsUsed) {
      if (!store.paymentMethods.includes(method)) {
        throw ApiError.badRequest(`"${method}" is not an enabled payment method for this store`);
      }
    }

    const customer = loyalty
      ? await customerService.resolveForSale(ctx, loyalty.membership.customerId)
      : await this.resolveCustomer(ctx, input);

    // Names the point redemption before the sale exists. The sale's own id is
    // still assigned at insert, which the monthly-allowance ordinal relies on.
    const checkoutRef = new Types.ObjectId();

    // ---- loyalty redemption (atomic; refused if the points are gone) ------
    let redeemed: { balanceAfter: number } | null = null;
    if (loyalty && redeemPoints > 0) {
      redeemed = await loyaltyService.redeemForSale(ctx, loyalty.membership._id, redeemPoints, checkoutRef);
    }
    const undoRedemption = async () => {
      if (loyalty && redeemed) await loyaltyService.reverseRedemption(ctx, loyalty.membership._id, redeemPoints, checkoutRef);
    };

    // ---- stock ------------------------------------------------------------
    const applied: StockMovementResult[] = [];
    // From the permissions resolved for THIS request (read from the database),
    // never from anything the client sends - so a revoked grant stops working
    // on the very next sale.
    const allowOutOfStock = ctx.can(PERMISSIONS.SALES_SELL_OUT_OF_STOCK);
    try {
      for (const line of lines) {
        const movement = await inventoryService.decreaseForSale(
          ctx,
          line.variantId,
          line.quantity,
          { type: INVENTORY_TX_TYPES.SALE, reason: 'POS sale', referenceType: 'sale' },
          { allowOutOfStock },
        );
        applied.push(movement);
      }
    } catch (error) {
      await inventoryService.compensate(ctx, applied, 'sale could not be completed');
      await undoRedemption();
      throw error;
    }

    // ---- persist ----------------------------------------------------------
    let saleDoc: InstanceType<typeof SaleModel> | null = null;
    try {
      const seq = await nextSequence(ctx.tenantId, ctx.storeId, 'sale');
      const saleNumber = formatDocumentNumber(store.invoicePrefix, seq);
      const soldAt = new Date();
      const qualifyingMinor = totals.subtotalMinor - totals.discountMinor - loyaltyDiscountMinor;

      saleDoc = await SaleModel.create({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        saleNumber,
        cashierId: ctx.userId,
        cashierNameSnapshot: ctx.userName,
        customerId: customer?._id ?? null,
        customerSnapshot: customer
          ? { name: customer.name, phone: customer.phone, email: customer.email ?? '' }
          : null,
        items: lines.map((line, index) => ({
          ...line,
          lineDiscountMinor: 0,
          returnedQuantity: 0,
          ...(applied[index]?.outOfStockOverride ? { outOfStockOverride: true } : {}),
        })),
        subtotalMinor: totals.subtotalMinor,
        // Includes the loyalty discount, so every report that subtracts discounts stays right.
        discountMinor: totals.discountMinor + loyaltyDiscountMinor,
        discountType: input.discountType,
        discountValue: input.discountValue,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        paidMinor: totals.paidMinor,
        changeMinor: totals.changeMinor,
        paymentMethod: input.paymentMethod,
        payments:
          creditMinor > 0 || takesNoMoney
            ? (input.payments ?? [])
            : (input.payments ?? [{ method: input.paymentMethod, amountMinor: totals.totalMinor, reference: '' }]),
        exchange: options.exchange ? { returnId: null, returnNumber: '', creditMinor, returnedItems: options.exchange.returnedItems } : null,
        loyalty: loyalty
          ? {
              membershipId: loyalty.membership._id,
              cardNumber: loyalty.membership.cardNumber,
              pointValueMinor: loyalty.settings.pointValueMinor,
              earnSpendMinor: loyalty.settings.earnSpendMinor,
              pointsRedeemed: redeemPoints,
              discountMinor: loyaltyDiscountMinor,
              qualifyingMinor,
              pointsEarned: 0,
              balanceAfter: redeemed?.balanceAfter ?? loyalty.membership.pointsBalance,
              pointsEarnedReversed: 0,
              pointsRedeemedRestored: 0,
            }
          : null,
        idempotencyKey: input.idempotencyKey ?? null,
        paymentStatus: totals.paymentStatus,
        status: SALE_STATUS.COMPLETED,
        note: input.note,
        soldAt,
      });
      const sale = saleDoc;

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

      // ---- loyalty earning: only now that the sale is complete, and once --
      if (loyalty) {
        await loyaltyService.attachSale(ctx, checkoutRef, sale._id, saleNumber);
        try {
          const points = pointsForSpend(qualifyingMinor, loyalty.settings.earnSpendMinor);
          const earned = await loyaltyService.earnForSale(ctx, loyalty.membership._id, points, { _id: sale._id, saleNumber });
          if (earned && sale.loyalty) {
            sale.loyalty.pointsEarned = points;
            sale.loyalty.balanceAfter = earned.balanceAfter;
            await SaleModel.updateOne(
              { _id: sale._id, tenantId: ctx.tenantId },
              { $set: { 'loyalty.pointsEarned': points, 'loyalty.balanceAfter': earned.balanceAfter } },
            );
          }
        } catch (error) {
          // The customer has paid and the sale stands; the missing points are logged for a manual adjustment.
          logger.error('CRITICAL: loyalty points could not be awarded for a completed sale', {
            tenantId: String(ctx.tenantId),
            saleId: String(sale._id),
            error,
          });
        }
      }

      return sale.toObject();
    } catch (error) {
      await inventoryService.compensate(ctx, applied, 'sale record could not be saved');
      await undoRedemption();
      // Two identical checkouts raced: the other one created the sale. Return it.
      if ((error as { code?: number }).code === 11000 && input.idempotencyKey) {
        const winner = await SaleModel.findOne({ ...this.scope(ctx), idempotencyKey: input.idempotencyKey }).lean();
        if (winner) return { ...winner, replayed: true };
      }
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

    // Points earned are taken back and points redeemed are given back.
    await loyaltyService.applyCancellation(ctx, sale.toObject(), input.reason);

    return (await SaleModel.findOne({ _id: sale._id, tenantId: ctx.tenantId }).lean()) ?? sale.toObject();
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

  /**
   * Prices the replacement side of an exchange WITHOUT selling anything: the
   * catalogue price of the exact variants chosen, no price overrides and no
   * discount, with VAT as the store charges it. Used to check the exchange rule
   * before any stock or return quantity moves.
   */
  async quoteReplacement(ctx: TenantContext, items: { variantId: Types.ObjectId; quantity: number }[]) {
    const store = await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).lean();
    if (!store) throw ApiError.notFound('Store not found');
    const input = { items, discountType: 'none', discountValue: 0, paymentMethod: 'cash', note: '' } as unknown as CreateSaleInput;
    const lines = await this.priceLines(ctx, input);
    const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    const taxMinor = store.tax.enabled && !store.tax.inclusive ? applyBasisPoints(subtotalMinor, store.tax.rateBasisPoints) : 0;
    return { lines, subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor };
  }

  /** All-integer money maths; no floats anywhere in this path. */
  private computeTotals(
    lines: PricedLine[],
    input: CreateSaleInput,
    tax: { enabled: boolean; rateBasisPoints: number; inclusive: boolean },
    creditMinor = 0,
    loyaltyDiscountMinor = 0,
  ) {
    const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);

    let discountMinor = 0;
    if (input.discountType === 'fixed') discountMinor = input.discountValue;
    else if (input.discountType === 'percent') discountMinor = applyBasisPoints(subtotalMinor, input.discountValue);
    discountMinor = clampDiscount(discountMinor, subtotalMinor);

    // Loyalty points are a discount AFTER the cart discount, and can never take
    // the goods below zero (so they never create a negative payable).
    if (loyaltyDiscountMinor > subtotalMinor - discountMinor) {
      throw ApiError.validation('The loyalty discount cannot be more than the amount of this sale.', {
        reason: 'LOYALTY_REDEMPTION_TOO_HIGH',
        maxDiscountMinor: subtotalMinor - discountMinor,
        loyaltyDiscountMinor,
      });
    }
    const taxableMinor = subtotalMinor - discountMinor - loyaltyDiscountMinor;
    // Inclusive tax is already inside the listed price, so it is reported but
    // not added again.
    const taxMinor = tax.enabled && !tax.inclusive ? applyBasisPoints(taxableMinor, tax.rateBasisPoints) : 0;

    const totalMinor = taxableMinor + taxMinor;
    // Points covering the whole sale leave nothing to pay; any other zero total is a mistake.
    if (totalMinor === 0 && loyaltyDiscountMinor > 0 && creditMinor === 0) {
      if (input.payments?.length || (input.cashTenderedMinor ?? 0) > 0) {
        throw ApiError.validation('Loyalty points cover this whole sale - remove the payment.', { reason: 'LOYALTY_NOTHING_PAYABLE' });
      }
      return { subtotalMinor, discountMinor, taxMinor, totalMinor, paidMinor: 0, changeMinor: 0, paymentStatus: 'paid' };
    }
    if (totalMinor <= 0) {
      throw ApiError.validation('The sale total must be greater than zero');
    }

    // The replacement side of an exchange: the returned items' value (credit)
    // pays for part of it, and the payments must cover EXACTLY the rest. Cash
    // handed over beyond the cash row is change, as at the till.
    if (creditMinor > 0) {
      if (creditMinor > totalMinor) {
        throw ApiError.validation('The replacement cannot be worth less than the returned items.', { totalMinor, creditMinor });
      }
      const dueMinor = totalMinor - creditMinor;
      const rows = input.payments ?? [];
      const appliedMinor = rows.reduce((sum, payment) => sum + payment.amountMinor, 0);
      if (appliedMinor !== dueMinor) {
        throw ApiError.validation(
          dueMinor === 0
            ? 'Nothing is payable on this exchange - remove the payments.'
            : `The extra payment (${appliedMinor}) must add up to exactly the amount due (${dueMinor}).`,
          { dueMinor, appliedMinor, reason: 'EXCHANGE_PAYMENT_MISMATCH' },
        );
      }
      let changeMinor = 0;
      if (input.cashTenderedMinor !== undefined) {
        const cashRow = rows.find((payment) => payment.method === 'cash');
        if (!cashRow) throw ApiError.validation('Cash received was entered, but no cash payment is part of this exchange.');
        if (input.cashTenderedMinor < cashRow.amountMinor) {
          throw ApiError.validation(`The cash received (${input.cashTenderedMinor}) is less than the cash due (${cashRow.amountMinor}).`, {
            cashDueMinor: cashRow.amountMinor,
            cashTenderedMinor: input.cashTenderedMinor,
            shortfallMinor: cashRow.amountMinor - input.cashTenderedMinor,
          });
        }
        changeMinor = input.cashTenderedMinor - cashRow.amountMinor;
      }
      return { subtotalMinor, discountMinor, taxMinor, totalMinor, paidMinor: totalMinor + changeMinor, changeMinor, paymentStatus: 'paid' };
    }

    // Cash tendered separately from what is applied to the sale. The payment
    // rows are what the sale is settled with and must equal the total exactly;
    // whatever cash was handed over beyond the cash row is change. So change can
    // never inflate revenue or the recorded cash takings.
    if (input.cashTenderedMinor !== undefined) {
      const rows = input.payments ?? [{ method: input.paymentMethod, amountMinor: totalMinor, reference: '' }];
      const appliedMinor = rows.reduce((sum, payment) => sum + payment.amountMinor, 0);
      if (appliedMinor !== totalMinor) {
        throw ApiError.validation(
          `The payments (${appliedMinor}) must add up to exactly the total (${totalMinor}). Cash handed over beyond that is change.`,
          { totalMinor, appliedMinor },
        );
      }
      const cashRow = rows.find((payment) => payment.method === 'cash');
      if (!cashRow) {
        throw ApiError.validation('Cash received was entered, but no cash payment is part of this sale.');
      }
      if (input.cashTenderedMinor < cashRow.amountMinor) {
        throw ApiError.validation(
          `The cash received (${input.cashTenderedMinor}) is less than the cash due (${cashRow.amountMinor}). Collect the full amount to complete this sale.`,
          { cashDueMinor: cashRow.amountMinor, cashTenderedMinor: input.cashTenderedMinor, shortfallMinor: cashRow.amountMinor - input.cashTenderedMinor },
        );
      }
      const cashChangeMinor = input.cashTenderedMinor - cashRow.amountMinor;
      // "Customer paid": everything handed over, including the change given back.
      return { subtotalMinor, discountMinor, taxMinor, totalMinor, paidMinor: totalMinor + cashChangeMinor, changeMinor: cashChangeMinor, paymentStatus: 'paid' };
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

  /** The same resolution every POS vertical uses; a walk-in sale has none. */
  private async resolveCustomer(ctx: TenantContext, input: CreateSaleInput) {
    return customerService.resolveForPosSale(ctx, input);
  }
}

export type { SaleItemDoc };
export const saleService = new SaleService();
