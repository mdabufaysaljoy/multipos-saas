import { Types, type PipelineStage } from 'mongoose';
import dayjs from 'dayjs';
import { PERMISSIONS } from '../../config/permissions';
import { DiningTableModel } from '../../models/DiningTable';
import { MenuItemModel } from '../../models/MenuItem';
import { RestaurantOrderModel, type RestaurantOrderLine } from '../../models/RestaurantOrder';
import { RestaurantShiftModel } from '../../models/RestaurantShift';
import { StoreModel } from '../../models/Store';
import { loadReceiptStore } from '../../services/receipt/receiptStore';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { resolveDashboardWindow } from '../reports/reports.service';
import { customerService } from '../customers/customers.service';
import { returnFiguresFor } from '../../services/returns/posReturns.figures';
import { POS_TENDER_DIALECT, settleTender, stampTenderLabels, tenderLabels } from '../../services/pos/paymentMethods.service';
import type { TenantContext } from '../../types/express';
import type {
  DashboardInput,
  CreateMenuItemInput,
  CreateOrderInput,
  CreateTableInput,
  ListMenuInput,
  ListOrdersInput,
  OrderLineInput,
  PayOrderInput,
  SummaryInput,
  UpdateMenuItemInput,
  UpdateTableInput,
} from './restaurant.validators';

const MAX_LINES = 100;
const MAX_TABLES_PER_BRANCH = 500;
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;
const exactName = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

/**
 * Restaurant POS.
 *
 * Built on the shared core: tenant and branch scope come from `ctx`, plan
 * limits from the entitlement service (menu items count against the products
 * limit, orders against the monthly sales limit), and permissions reuse the
 * existing keys, so staff roles work unchanged.
 *
 * Money rules:
 *  - a line's price is read from the menu on the server when the line is added,
 *    and frozen on the line
 *  - totals are recomputed from the lines inside the same atomic update
 *  - payment is a single conditional update from `open`, against the revision
 *    the cashier saw, so an order cannot be paid twice or while being changed
 */
class RestaurantService {
  // ======================================================================
  //  Menu
  // ======================================================================

  async listMenu(ctx: TenantContext, input: ListMenuInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, deletedAt: null };
    if (input.availableOnly) filter.isAvailable = true;
    if (input.category) filter.category = input.category;
    if (input.search) filter.name = searchRegex(input.search);

    const [items, total] = await Promise.all([
      MenuItemModel.find(filter).sort({ category: 1, sortOrder: 1, name: 1 }).skip(skip).limit(limit).lean(),
      MenuItemModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  async createMenuItem(ctx: TenantContext, input: CreateMenuItemInput) {
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertWithinLimit(entitlement, 'maxProducts', await this.countMenuItems(ctx.tenantId), 'menu items');
    await this.assertMenuNameFree(ctx, input.name);

    const item = await MenuItemModel.create({ ...input, tenantId: ctx.tenantId, createdBy: ctx.userId });

    // The pre-flight count is not atomic; confirm by ordinal, undo if over.
    const ordinal = await MenuItemModel.countDocuments({ tenantId: ctx.tenantId, deletedAt: null, _id: { $lte: item._id } });
    try {
      entitlementService.assertOrdinalWithinLimit(entitlement, 'maxProducts', ordinal, 'menu items');
    } catch (error) {
      await MenuItemModel.deleteOne({ _id: item._id, tenantId: ctx.tenantId });
      throw error;
    }
    return item.toObject();
  }

  async updateMenuItem(ctx: TenantContext, id: Types.ObjectId, input: UpdateMenuItemInput) {
    const item = await MenuItemModel.findOne({ _id: id, tenantId: ctx.tenantId, deletedAt: null });
    if (!item) throw ApiError.notFound('Menu item not found');
    if (input.name && input.name.toLowerCase() !== item.name.toLowerCase()) await this.assertMenuNameFree(ctx, input.name, id);

    // Explicit fields only: the validator already rejects anything else.
    const fields = ['name', 'category', 'description', 'priceMinor', 'isAvailable', 'sortOrder'] as const;
    for (const field of fields) {
      if (input[field] !== undefined) item.set(field, input[field]);
    }
    await item.save();
    return item.toObject();
  }

  /** Soft delete: past orders keep their snapshots; the item can never be ordered again. */
  async removeMenuItem(ctx: TenantContext, id: Types.ObjectId) {
    const item = await MenuItemModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, deletedAt: null },
      { $set: { deletedAt: new Date(), isAvailable: false } },
      { new: true },
    ).lean();
    if (!item) throw ApiError.notFound('Menu item not found');
    return { id: item._id };
  }

  // ======================================================================
  //  Tables (per branch)
  // ======================================================================

  async listTables(ctx: TenantContext) {
    const tables = await DiningTableModel.find({ tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null })
      .sort({ name: 1 })
      .lean();
    const open = await RestaurantOrderModel.find({
      tenantId: ctx.tenantId,
      storeId: ctx.storeId,
      status: 'open',
      tableId: { $in: tables.map((t) => t._id) },
    })
      .select('_id tableId orderNumber totalMinor')
      .lean();

    return tables.map((table) => {
      const order = open.find((o) => o.tableId && o.tableId.equals(table._id));
      return {
        ...table,
        openOrderId: order?._id ?? null,
        openOrderNumber: order?.orderNumber ?? null,
        openOrderTotalMinor: order?.totalMinor ?? null,
      };
    });
  }

  async createTable(ctx: TenantContext, input: CreateTableInput) {
    const scope = { tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null };
    if ((await DiningTableModel.countDocuments(scope)) >= MAX_TABLES_PER_BRANCH) {
      throw ApiError.conflict(`A branch can have up to ${MAX_TABLES_PER_BRANCH} tables.`);
    }
    if (await DiningTableModel.exists({ ...scope, name: exactName(input.name) })) {
      throw ApiError.conflict('A table with this name already exists in this branch');
    }
    const table = await DiningTableModel.create({ ...input, tenantId: ctx.tenantId, storeId: ctx.storeId });
    return table.toObject();
  }

  async updateTable(ctx: TenantContext, id: Types.ObjectId, input: UpdateTableInput) {
    const table = await DiningTableModel.findOne({ _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null });
    if (!table) throw ApiError.notFound('Table not found');
    if (input.name && input.name.toLowerCase() !== table.name.toLowerCase()) {
      const clash = await DiningTableModel.exists({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        deletedAt: null,
        _id: { $ne: id },
        name: exactName(input.name),
      });
      if (clash) throw ApiError.conflict('A table with this name already exists in this branch');
    }
    if (input.isActive === false && (await this.tableHasOpenOrder(ctx, id))) {
      throw ApiError.conflict('Settle or cancel the open order on this table first');
    }
    for (const field of ['name', 'seats', 'isActive'] as const) {
      if (input[field] !== undefined) table.set(field, input[field]);
    }
    await table.save();
    return table.toObject();
  }

  async removeTable(ctx: TenantContext, id: Types.ObjectId) {
    if (await this.tableHasOpenOrder(ctx, id)) throw ApiError.conflict('Settle or cancel the open order on this table first');
    const table = await DiningTableModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId, deletedAt: null },
      { $set: { deletedAt: new Date(), isActive: false } },
      { new: true },
    ).lean();
    if (!table) throw ApiError.notFound('Table not found');
    return { id: table._id };
  }

  // ======================================================================
  //  Orders
  // ======================================================================

  async listOrders(ctx: TenantContext, input: ListOrdersInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, storeId: ctx.storeId };
    if (input.status) filter.status = input.status;
    if (input.type) filter.type = input.type;
    if (input.from || input.to) {
      filter.createdAt = {
        ...(input.from ? { $gte: dayjs(input.from).startOf('day').toDate() } : {}),
        ...(input.to ? { $lte: dayjs(input.to).endOf('day').toDate() } : {}),
      };
    }
    const [items, total] = await Promise.all([
      RestaurantOrderModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      RestaurantOrderModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  async getOrder(ctx: TenantContext, id: Types.ObjectId) {
    const order = await RestaurantOrderModel.findOne({ _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId }).lean();
    if (!order) throw ApiError.notFound('Order not found');
    return order;
  }

  async createOrder(ctx: TenantContext, input: CreateOrderInput) {
    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    entitlementService.assertWithinLimit(entitlement, 'maxMonthlySales', await this.countMonthlyOrders(ctx.tenantId), 'orders per month');

    let tableNameSnapshot = '';
    if (input.tableId) {
      const table = await DiningTableModel.findOne({
        _id: input.tableId,
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        deletedAt: null,
        isActive: true,
      })
        .select('name')
        .lean();
      if (!table) throw ApiError.badRequest('That table is not available in this branch');
      tableNameSnapshot = table.name;
    }

    // Optional, and resolved the same way in every vertical: an existing
    // customer, or one created at the till from a name and phone. A restaurant
    // customer belongs to the ORDER - the table is booked in their name long
    // before anyone pays.
    const customer = await customerService.resolveForPosSale(ctx, input);

    const lines = await this.priceLines(ctx, input.items);
    const subtotalMinor = this.sumLines(lines);
    const seq = await nextSequence(ctx.tenantId, ctx.storeId, 'restaurant-order');

    let order;
    try {
      order = await RestaurantOrderModel.create({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        orderNumber: formatDocumentNumber('ORD-', seq),
        type: input.type,
        tableId: input.tableId ?? null,
        tableNameSnapshot,
        customerId: customer?._id ?? null,
        customerNameSnapshot: customer?.name ?? '',
        items: lines,
        subtotalMinor,
        discountMinor: 0,
        totalMinor: subtotalMinor,
        status: 'open',
        note: input.note,
        rev: 0,
        openedBy: ctx.userId,
        openedByNameSnapshot: ctx.userName,
      });
    } catch (error) {
      if (isDuplicateKey(error) && input.tableId) throw ApiError.conflict('This table already has an open order');
      throw error;
    }

    // Monthly allowance, confirmed by ordinal now the order exists.
    const ordinal = await RestaurantOrderModel.countDocuments({
      tenantId: ctx.tenantId,
      status: { $ne: 'cancelled' },
      createdAt: { $gte: dayjs().startOf('month').toDate() },
      _id: { $lte: order._id },
    });
    try {
      entitlementService.assertOrdinalWithinLimit(entitlement, 'maxMonthlySales', ordinal, 'orders per month');
    } catch (error) {
      await RestaurantOrderModel.deleteOne({ _id: order._id, tenantId: ctx.tenantId });
      throw error;
    }

    return order.toObject();
  }

  async addItems(ctx: TenantContext, id: Types.ObjectId, items: OrderLineInput[]) {
    const lines = await this.priceLines(ctx, items);
    return this.mutateOpenOrder(
      ctx,
      id,
      { $expr: { $lte: [{ $add: [{ $size: '$items' }, lines.length] }, MAX_LINES] } },
      [{ $set: { items: { $concatArrays: ['$items', { $literal: lines }] } } }],
      `An order can hold at most ${MAX_LINES} lines`,
    );
  }

  async updateLine(ctx: TenantContext, id: Types.ObjectId, lineId: Types.ObjectId, quantity: number) {
    return this.mutateOpenOrder(
      ctx,
      id,
      // A voided line is history; it cannot be revived by editing it.
      { items: { $elemMatch: { _id: lineId, voidedAt: null } } },
      [
        {
          $set: {
            items: {
              $map: {
                input: '$items',
                as: 'line',
                in: {
                  $cond: [
                    { $eq: ['$$line._id', lineId] },
                    // The frozen unit price is reused; only the quantity changes.
                    { $mergeObjects: ['$$line', { quantity, lineTotalMinor: { $multiply: ['$$line.unitPriceMinor', quantity] } }] },
                    '$$line',
                  ],
                },
              },
            },
          },
        },
      ],
      'That line is not on this order',
    );
  }

  /**
   * A line the kitchen has never seen is simply deleted. A line it HAS seen is
   * voided instead - kept at quantity 0 - so the next kitchen ticket can tell
   * the kitchen to stop, and the order keeps an honest record.
   */
  async removeLine(ctx: TenantContext, id: Types.ObjectId, lineId: Types.ObjectId) {
    const isTarget = { $eq: ['$$line._id', lineId] };
    const unsent = { $eq: [{ $ifNull: ['$$line.sentQuantity', 0] }, 0] };
    return this.mutateOpenOrder(
      ctx,
      id,
      { items: { $elemMatch: { _id: lineId, voidedAt: null } } },
      [
        { $set: { items: { $filter: { input: '$items', as: 'line', cond: { $not: [{ $and: [isTarget, unsent] }] } } } } },
        {
          $set: {
            items: {
              $map: {
                input: '$items',
                as: 'line',
                in: { $cond: [isTarget, { $mergeObjects: ['$$line', { quantity: 0, lineTotalMinor: 0, voidedAt: '$$NOW' }] }, '$$line'] },
              },
            },
          },
        },
      ],
      'That line is not on this order',
    );
  }

  // ----------------------------------------------------------------- kitchen

  /**
   * Sends everything the kitchen has not been told about as one ticket: new
   * lines, extra quantity, and voids (as negative quantities).
   *
   * The ticket is computed from the order at `rev`, and the update only applies
   * at that same revision, so what the kitchen receives is exactly what the
   * cashier saw and two sends cannot both deliver the same change.
   */
  async sendToKitchen(ctx: TenantContext, id: Types.ObjectId, rev: number) {
    const order = await this.getOrder(ctx, id);
    if (order.status !== 'open') throw ApiError.conflict(`A ${order.status} order cannot be sent to the kitchen`);
    if ((order.rev ?? 0) !== rev) throw ApiError.conflict('The order changed since it was opened. Refresh and try again.');

    const lines = order.items
      .map((line) => ({
        lineId: line._id,
        nameSnapshot: line.nameSnapshot,
        quantity: line.quantity - (line.sentQuantity ?? 0),
        note: line.note ?? '',
      }))
      .filter((line) => line.quantity !== 0);
    if (lines.length === 0) throw ApiError.badRequest('Nothing new to send to the kitchen');

    const seq = await nextSequence(ctx.tenantId, ctx.storeId, 'kitchen-ticket');
    const ticket = {
      _id: new Types.ObjectId(),
      ticketNumber: formatDocumentNumber('KOT-', seq),
      lines,
      status: 'pending',
      createdAt: new Date(),
      createdBy: ctx.userId,
      createdByNameSnapshot: ctx.userName,
      readyAt: null,
      readyByNameSnapshot: '',
    };

    const updated = await RestaurantOrderModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'open', rev },
      [
        {
          $set: {
            items: { $map: { input: '$items', as: 'line', in: { $mergeObjects: ['$$line', { sentQuantity: '$$line.quantity' }] } } },
            tickets: { $concatArrays: [{ $ifNull: ['$tickets', []] }, [{ $literal: ticket }]] },
            rev: { $add: [{ $ifNull: ['$rev', 0] }, 1] },
          },
        },
      ] as never,
      { new: true },
    ).lean();
    if (!updated) throw ApiError.conflict('The order changed or was already settled. Refresh and try again.');
    return updated;
  }

  /** Tickets waiting in (or recently finished by) the kitchen of this branch. */
  async kitchenQueue(ctx: TenantContext, status: 'pending' | 'ready') {
    const since = dayjs().subtract(12, 'hour').toDate();
    return RestaurantOrderModel.aggregate([
      { $match: { tenantId: ctx.tenantId, storeId: ctx.storeId, 'tickets.status': status } },
      { $unwind: '$tickets' },
      { $match: { 'tickets.status': status, ...(status === 'ready' ? { 'tickets.readyAt': { $gte: since } } : {}) } },
      {
        $project: {
          _id: '$tickets._id',
          ticketNumber: '$tickets.ticketNumber',
          lines: '$tickets.lines',
          status: '$tickets.status',
          createdAt: '$tickets.createdAt',
          createdByNameSnapshot: '$tickets.createdByNameSnapshot',
          readyAt: '$tickets.readyAt',
          readyByNameSnapshot: '$tickets.readyByNameSnapshot',
          orderId: '$_id',
          orderNumber: '$orderNumber',
          type: '$type',
          tableNameSnapshot: '$tableNameSnapshot',
          orderNote: '$note',
        },
      },
      // The oldest pending ticket is the one to cook next; ready shows the latest.
      { $sort: status === 'pending' ? { createdAt: 1 } : { readyAt: -1 } },
      { $limit: 100 },
    ]);
  }

  /** Doesn't touch the order revision, so the kitchen never blocks a payment. */
  async markTicketReady(ctx: TenantContext, orderId: Types.ObjectId, ticketId: Types.ObjectId) {
    const updated = await RestaurantOrderModel.findOneAndUpdate(
      { _id: orderId, tenantId: ctx.tenantId, storeId: ctx.storeId, tickets: { $elemMatch: { _id: ticketId, status: 'pending' } } },
      { $set: { 'tickets.$.status': 'ready', 'tickets.$.readyAt': new Date(), 'tickets.$.readyByNameSnapshot': ctx.userName } },
      { new: true, timestamps: false },
    ).lean();
    if (updated) return updated;

    const order = await this.getOrder(ctx, orderId);
    const ticket = (order.tickets ?? []).find((t) => t._id.equals(ticketId));
    if (!ticket) throw ApiError.notFound('Kitchen ticket not found');
    throw ApiError.conflict(`This ticket is already ${ticket.status}`);
  }

  /** Everything needed to (re)print one kitchen ticket. */
  async kitchenTicket(ctx: TenantContext, orderId: Types.ObjectId, ticketId: Types.ObjectId) {
    const order = await this.getOrder(ctx, orderId);
    const ticket = (order.tickets ?? []).find((t) => t._id.equals(ticketId));
    if (!ticket) throw ApiError.notFound('Kitchen ticket not found');
    const store = await this.printStore(ctx);
    return {
      ticket,
      order: {
        _id: order._id,
        orderNumber: order.orderNumber,
        type: order.type,
        tableNameSnapshot: order.tableNameSnapshot,
        note: order.note,
      },
      store,
    };
  }

  /**
   * The printable document for an order: a BILL while it is open (what the
   * guest will be asked to pay), a RECEIPT once paid. Voided lines are left
   * out. A cancelled order has nothing to print.
   */
  async receipt(ctx: TenantContext, id: Types.ObjectId) {
    const order = await this.getOrder(ctx, id);
    if (order.status === 'cancelled') throw ApiError.conflict('A cancelled order has no bill or receipt');
    const store = await this.printStore(ctx);
    return {
      kind: order.status === 'paid' ? ('receipt' as const) : ('bill' as const),
      order: { ...order, items: order.items.filter((line) => line.quantity > 0), tickets: undefined },
      store,
    };
  }

  private async printStore(ctx: TenantContext) {
    const store = await loadReceiptStore(ctx.tenantId, ctx.storeId);
    return store;
  }

  async payOrder(ctx: TenantContext, id: Types.ObjectId, input: PayOrderInput) {
    const order = await this.getOrder(ctx, id);
    if (order.status !== 'open') throw ApiError.conflict(`This order is already ${order.status}`);
    if (order.items.every((line) => line.quantity === 0)) throw ApiError.badRequest('Add at least one item before taking payment');
    if (order.rev !== input.rev) throw ApiError.conflict('The order changed since it was opened. Refresh and try again.');

    if (input.discountMinor > 0 && !ctx.can(PERMISSIONS.SALES_DISCOUNT)) {
      throw ApiError.forbidden('You do not have permission to give a discount');
    }
    if (input.discountMinor > order.subtotalMinor) throw ApiError.badRequest('The discount cannot exceed the order subtotal');

    const store = await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).select('paymentMethods').lean();

    const totalMinor = order.subtotalMinor - input.discountMinor;
    // Enabled for the branch, covering the total, change only out of cash:
    // the same three rules every POS settles by.
    const { paidMinor, changeMinor } = settleTender({
      totalMinor,
      tendered: input.payments,
      accepted: store?.paymentMethods ?? [],
      dialect: POS_TENDER_DIALECT,
    });
    // Each row keeps the name the workspace uses for that method today.
    const paidWith = stampTenderLabels(input.payments, await tenderLabels(ctx.tenantId));

    // The drawer this money goes into. A branch not using shifts pays with none.
    const shift = await RestaurantShiftModel.findOne({ tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'open' })
      .select('_id')
      .lean();

    const paid = await RestaurantOrderModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'open', rev: input.rev },
      {
        $set: {
          status: 'paid',
          discountMinor: input.discountMinor,
          totalMinor,
          paidMinor,
          changeMinor,
          payments: paidWith,
          paidAt: new Date(),
          paidBy: ctx.userId,
          paidByNameSnapshot: ctx.userName,
          shiftId: shift?._id ?? null,
        },
      },
      { new: true },
    ).lean();
    if (!paid) throw ApiError.conflict('The order was changed or already settled. Refresh and try again.');

    // An order only counts towards a customer's lifetime value once it is paid;
    // an open order is not yet revenue, and a cancelled one never will be.
    if (paid.customerId) {
      await customerService.applySaleStats(ctx, paid.customerId, { amountMinor: totalMinor, orderDelta: 1, purchasedAt: paid.paidAt ?? new Date() });
    }

    return paid;
  }

  async cancelOrder(ctx: TenantContext, id: Types.ObjectId, reason: string) {
    // One update: the order is cancelled AND any ticket the kitchen has not
    // finished is voided, so the kitchen stops cooking it.
    const cancelled = await RestaurantOrderModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'open' },
      [
        {
          $set: {
            status: 'cancelled',
            cancelledAt: '$$NOW',
            cancelledBy: { $literal: ctx.userId },
            cancelReason: { $literal: reason },
            tickets: {
              $map: {
                input: { $ifNull: ['$tickets', []] },
                as: 'ticket',
                in: { $cond: [{ $eq: ['$$ticket.status', 'pending'] }, { $mergeObjects: ['$$ticket', { status: 'void' }] }, '$$ticket'] },
              },
            },
          },
        },
      ] as never,
      { new: true },
    ).lean();
    if (cancelled) return cancelled;
    const order = await this.getOrder(ctx, id);
    throw ApiError.conflict(`A ${order.status} order cannot be cancelled`);
  }

  /** Trading summary for a day range in the current branch (today by default). */
  async summary(ctx: TenantContext, input: SummaryInput) {
    const from = (input.from ? dayjs(input.from) : dayjs()).startOf('day').toDate();
    const to = (input.to ? dayjs(input.to) : dayjs()).endOf('day').toDate();
    const paidMatch = { tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'paid', paidAt: { $gte: from, $lte: to } };

    const [totals, byMethod, topItems, openOrders] = await Promise.all([
      RestaurantOrderModel.aggregate<{ paidOrders: number; revenueMinor: number; discountsMinor: number; changeMinor: number }>([
        { $match: paidMatch },
        {
          $group: {
            _id: null,
            paidOrders: { $sum: 1 },
            revenueMinor: { $sum: '$totalMinor' },
            discountsMinor: { $sum: '$discountMinor' },
            changeMinor: { $sum: '$changeMinor' },
          },
        },
      ]),
      RestaurantOrderModel.aggregate<{ _id: string; amountMinor: number; count: number }>([
        { $match: paidMatch },
        { $unwind: '$payments' },
        { $group: { _id: '$payments.method', amountMinor: { $sum: '$payments.amountMinor' }, count: { $sum: 1 } } },
      ]),
      RestaurantOrderModel.aggregate<{ _id: Types.ObjectId; name: string; quantity: number; revenueMinor: number }>([
        { $match: paidMatch },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.menuItemId',
            name: { $last: '$items.nameSnapshot' },
            quantity: { $sum: '$items.quantity' },
            revenueMinor: { $sum: '$items.lineTotalMinor' },
          },
        },
        { $sort: { quantity: -1, revenueMinor: -1 } },
        { $limit: 5 },
      ]),
      RestaurantOrderModel.countDocuments({ tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'open' }),
    ]);

    const row = totals[0];
    const paidOrders = row?.paidOrders ?? 0;
    const revenueMinor = row?.revenueMinor ?? 0;
    const change = row?.changeMinor ?? 0;

    return {
      from,
      to,
      paidOrders,
      revenueMinor,
      discountsMinor: row?.discountsMinor ?? 0,
      averageOrderMinor: paidOrders > 0 ? Math.round(revenueMinor / paidOrders) : 0,
      openOrders,
      // Cash is reported net of change given, so the method totals reconcile to revenue.
      byPaymentMethod: byMethod
        .map((m) => ({ method: m._id, amountMinor: m._id === 'cash' ? m.amountMinor - change : m.amountMinor, count: m.count }))
        .sort((a, b) => b.amountMinor - a.amountMinor),
      topItems: topItems.map((item) => ({ menuItemId: item._id, name: item.name, quantity: item.quantity, revenueMinor: item.revenueMinor })),
    };
  }

  /**
   * The Restaurant dashboard for the current branch.
   *
   * Trading figures cover the chosen range and are compared with the period of
   * equal length just before it. The live floor (open orders, occupied tables)
   * is always "right now", whatever the range. Every figure is an aggregation
   * over order snapshots, so it never shifts when the menu changes.
   */
  async dashboard(ctx: TenantContext, input: DashboardInput) {
    const { bucket, format, timezone, previousFrom, previousTo, ...range } = resolveDashboardWindow(input);

    const scope = { tenantId: ctx.tenantId, storeId: ctx.storeId };
    const paidIn = (from: Date, to: Date) => ({ ...scope, status: 'paid', paidAt: { $gte: from, $lte: to } });
    const paidMatch = paidIn(range.from, range.to);

    const refunds = await returnFiguresFor(ctx, 'restaurant', { from: range.from, to: range.to });

    const [current, previous, trend, byMethod, byType, topItems, byStaff, cancelledOrders, tableCount, openNow, recentOrders] =
      await Promise.all([
        this.periodTotals(paidMatch),
        this.periodTotals(paidIn(previousFrom, previousTo)),
        RestaurantOrderModel.aggregate<{ _id: string; revenueMinor: number; orders: number }>([
          { $match: paidMatch },
          { $group: { _id: { $dateToString: { format, date: '$paidAt', timezone } }, revenueMinor: { $sum: '$totalMinor' }, orders: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]),
        RestaurantOrderModel.aggregate<{ _id: string; amountMinor: number; count: number }>([
          { $match: paidMatch },
          { $unwind: '$payments' },
          { $group: { _id: '$payments.method', amountMinor: { $sum: '$payments.amountMinor' }, count: { $sum: 1 } } },
        ]),
        RestaurantOrderModel.aggregate<{ _id: string; orders: number; revenueMinor: number }>([
          { $match: paidMatch },
          { $group: { _id: '$type', orders: { $sum: 1 }, revenueMinor: { $sum: '$totalMinor' } } },
        ]),
        RestaurantOrderModel.aggregate<{ _id: Types.ObjectId; name: string; quantity: number; revenueMinor: number }>([
          { $match: paidMatch },
          { $unwind: '$items' },
          {
            $group: {
              _id: '$items.menuItemId',
              name: { $last: '$items.nameSnapshot' },
              quantity: { $sum: '$items.quantity' },
              revenueMinor: { $sum: '$items.lineTotalMinor' },
            },
          },
          { $sort: { quantity: -1, revenueMinor: -1 } },
          { $limit: 5 },
        ]),
        RestaurantOrderModel.aggregate<{ _id: Types.ObjectId | null; name: string; orders: number; revenueMinor: number }>([
          { $match: paidMatch },
          { $group: { _id: '$paidBy', name: { $last: '$paidByNameSnapshot' }, orders: { $sum: 1 }, revenueMinor: { $sum: '$totalMinor' } } },
          { $sort: { revenueMinor: -1 } },
          { $limit: 5 },
        ]),
        RestaurantOrderModel.countDocuments({ ...scope, status: 'cancelled', cancelledAt: { $gte: range.from, $lte: range.to } }),
        DiningTableModel.countDocuments({ ...scope, deletedAt: null, isActive: true }),
        RestaurantOrderModel.aggregate<{ orders: number; valueMinor: number; tables: Types.ObjectId[] }>([
          { $match: { ...scope, status: 'open' } },
          { $group: { _id: null, orders: { $sum: 1 }, valueMinor: { $sum: '$totalMinor' }, tables: { $addToSet: '$tableId' } } },
        ]),
        RestaurantOrderModel.find(scope)
          .sort({ createdAt: -1 })
          .limit(6)
          .select('orderNumber type tableNameSnapshot totalMinor status createdAt')
          .lean(),
      ]);

    const open = openNow[0];
    const average = (totals: { paidOrders: number; revenueMinor: number }) =>
      totals.paidOrders > 0 ? Math.round(totals.revenueMinor / totals.paidOrders) : 0;

    return {
      range: { from: range.from, to: range.to, label: range.label, preset: input.preset, bucket },
      kpis: {
        revenueMinor: current.revenueMinor,
        paidOrders: current.paidOrders,
        averageOrderMinor: average(current),
        itemsSold: current.itemsSold,
        discountsMinor: current.discountsMinor,
        cancelledOrders,
        refundCount: refunds.count,
        refundedMinor: refunds.totalMinor,
        // What the restaurant actually kept: charged less refunded.
        netRevenueMinor: current.revenueMinor - refunds.totalMinor,
      },
      previous: {
        revenueMinor: previous.revenueMinor,
        paidOrders: previous.paidOrders,
        averageOrderMinor: average(previous),
      },
      live: {
        openOrders: open?.orders ?? 0,
        openOrdersValueMinor: open?.valueMinor ?? 0,
        tables: tableCount,
        occupiedTables: (open?.tables ?? []).filter(Boolean).length,
      },
      trend: trend.map((row) => ({ bucket: row._id, revenueMinor: row.revenueMinor, orders: row.orders })),
      // Cash net of the change handed back, so methods reconcile to revenue.
      byPaymentMethod: byMethod
        .map((m) => ({ method: m._id, amountMinor: m._id === 'cash' ? m.amountMinor - current.changeMinor : m.amountMinor, count: m.count }))
        .sort((a, b) => b.amountMinor - a.amountMinor),
      byType: (['dine_in', 'takeaway'] as const).map((type) => {
        const row = byType.find((t) => t._id === type);
        return { type, orders: row?.orders ?? 0, revenueMinor: row?.revenueMinor ?? 0 };
      }),
      topItems: topItems.map((item) => ({ menuItemId: item._id, name: item.name, quantity: item.quantity, revenueMinor: item.revenueMinor })),
      byStaff: byStaff.map((row) => ({ userId: row._id, name: row.name || 'Unknown', orders: row.orders, revenueMinor: row.revenueMinor })),
      recentOrders,
    };
  }

  // ======================================================================
  //  Internals
  // ======================================================================

  private async periodTotals(match: Record<string, unknown>) {
    const [row] = await RestaurantOrderModel.aggregate<{
      paidOrders: number;
      revenueMinor: number;
      discountsMinor: number;
      changeMinor: number;
      itemsSold: number;
    }>([
      { $match: match },
      {
        $group: {
          _id: null,
          paidOrders: { $sum: 1 },
          revenueMinor: { $sum: '$totalMinor' },
          discountsMinor: { $sum: '$discountMinor' },
          changeMinor: { $sum: '$changeMinor' },
          itemsSold: { $sum: { $sum: '$items.quantity' } },
        },
      },
    ]);
    return {
      paidOrders: row?.paidOrders ?? 0,
      revenueMinor: row?.revenueMinor ?? 0,
      discountsMinor: row?.discountsMinor ?? 0,
      changeMinor: row?.changeMinor ?? 0,
      itemsSold: row?.itemsSold ?? 0,
    };
  }

  /** Prices lines from the menu - the only source of a price. */
  private async priceLines(ctx: TenantContext, items: OrderLineInput[]): Promise<RestaurantOrderLine[]> {
    const ids = [...new Set(items.map((item) => String(item.menuItemId)))].map((id) => new Types.ObjectId(id));
    const menu = await MenuItemModel.find({ _id: { $in: ids }, tenantId: ctx.tenantId, deletedAt: null }).lean();

    const now = new Date();
    return items.map((item) => {
      const entry = menu.find((m) => m._id.equals(item.menuItemId));
      if (!entry) throw ApiError.badRequest('One of the items is not on this menu');
      if (!entry.isAvailable) throw ApiError.badRequest(`${entry.name} is not available right now`);
      const lineTotalMinor = entry.priceMinor * item.quantity;
      if (!Number.isSafeInteger(lineTotalMinor)) throw ApiError.badRequest('That line is too large');
      return {
        _id: new Types.ObjectId(),
        menuItemId: entry._id,
        nameSnapshot: entry.name,
        categorySnapshot: entry.category,
        unitPriceMinor: entry.priceMinor,
        quantity: item.quantity,
        note: item.note,
        lineTotalMinor,
        addedAt: now,
        sentQuantity: 0,
        voidedAt: null,
      };
    });
  }

  private sumLines(lines: RestaurantOrderLine[]) {
    return lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  }

  /**
   * Applies a change to an OPEN order and recomputes its totals, all in one
   * atomic update - so concurrent edits cannot leave totals out of step with
   * the lines, and every change bumps the revision payment checks against.
   */
  private async mutateOpenOrder(
    ctx: TenantContext,
    id: Types.ObjectId,
    extraFilter: Record<string, unknown>,
    stages: PipelineStage.AddFields[] | Record<string, unknown>[],
    notAppliedMessage: string,
  ) {
    const recompute = [
      { $set: { subtotalMinor: { $sum: '$items.lineTotalMinor' } } },
      {
        $set: {
          totalMinor: { $max: [0, { $subtract: ['$subtotalMinor', '$discountMinor'] }] },
          rev: { $add: [{ $ifNull: ['$rev', 0] }, 1] },
        },
      },
    ];

    const updated = await RestaurantOrderModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, storeId: ctx.storeId, status: 'open', ...extraFilter },
      [...stages, ...recompute] as never,
      { new: true },
    ).lean();
    if (updated) return updated;

    const order = await this.getOrder(ctx, id);
    if (order.status !== 'open') throw ApiError.conflict('Only an open order can be changed');
    throw ApiError.conflict(notAppliedMessage);
  }

  private async assertMenuNameFree(ctx: TenantContext, name: string, exceptId?: Types.ObjectId) {
    const clash = await MenuItemModel.exists({
      tenantId: ctx.tenantId,
      deletedAt: null,
      name: exactName(name),
      ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    });
    if (clash) throw ApiError.conflict('A menu item with this name already exists');
  }

  private tableHasOpenOrder(ctx: TenantContext, tableId: Types.ObjectId) {
    return RestaurantOrderModel.exists({ tenantId: ctx.tenantId, storeId: ctx.storeId, tableId, status: 'open' });
  }

  /** The same meters the subscription page and downgrade checks read. */
  countMenuItems(tenantId: Types.ObjectId) {
    return entitlementService.countProducts(tenantId, 'restaurant');
  }

  countMonthlyOrders(tenantId: Types.ObjectId) {
    return entitlementService.countMonthlySales(tenantId, 'restaurant');
  }
}

export const restaurantService = new RestaurantService();
