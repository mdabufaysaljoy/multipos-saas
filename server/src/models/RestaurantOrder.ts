import { Schema, model, type Types } from 'mongoose';
import type { PaymentMethod } from '../config/constants';
import type { BaseDoc } from './types';
import { saleLoyaltySchema, type SaleLoyaltySnapshot } from './saleLoyalty';

export const RESTAURANT_ORDER_TYPES = ['dine_in', 'takeaway'] as const;
export type RestaurantOrderType = (typeof RESTAURANT_ORDER_TYPES)[number];

/** open -> paid, or open -> cancelled. A paid order is final. */
export const RESTAURANT_ORDER_STATUSES = ['open', 'paid', 'cancelled'] as const;
export type RestaurantOrderStatus = (typeof RESTAURANT_ORDER_STATUSES)[number];

export interface RestaurantOrderLine {
  _id: Types.ObjectId;
  menuItemId: Types.ObjectId;
  /** Copied from the menu when the line was added; never re-read afterwards. */
  nameSnapshot: string;
  categorySnapshot: string;
  unitPriceMinor: number;
  quantity: number;
  note: string;
  lineTotalMinor: number;
  addedAt: Date;
  /** How many of this line the kitchen has already been told about. */
  sentQuantity: number;
  /**
   * Set when a line the kitchen already had is removed. The line is kept at
   * quantity 0 (so the next ticket can say VOID) instead of being deleted.
   */
  voidedAt: Date | null;
  /** How much of this line has been refunded. Absent on orders paid before returns existed. */
  returnedQuantity?: number;
}

export const KITCHEN_TICKET_STATUSES = ['pending', 'ready', 'void'] as const;
export type KitchenTicketStatus = (typeof KITCHEN_TICKET_STATUSES)[number];

export interface KitchenTicketLine {
  lineId: Types.ObjectId;
  nameSnapshot: string;
  /** Change since the previous ticket: positive to make, negative to void. */
  quantity: number;
  note: string;
}

/** A kitchen order ticket (KOT): what changed on the order since the last one. */
export interface KitchenTicket {
  _id: Types.ObjectId;
  ticketNumber: string;
  lines: KitchenTicketLine[];
  status: KitchenTicketStatus;
  createdAt: Date;
  createdBy: Types.ObjectId | null;
  createdByNameSnapshot: string;
  readyAt: Date | null;
  readyByNameSnapshot: string;
}

export interface RestaurantOrderPayment {
  /** A key, built-in or one this workspace defined. */
  method: PaymentMethod | string;
  amountMinor: number;
  /** What the till called it, kept so a rename cannot rewrite history. */
  methodLabel?: string;
}

/**
 * A dine-in or takeaway order in one branch.
 *
 * Every price is a snapshot taken on the server when the line was added, so
 * historical orders stay exact whatever happens to the menu. Totals are always
 * recomputed from the lines inside the same atomic update that changes them.
 */
/** What an order did to a loyalty card: the shared snapshot, under this vertical's name. */
export type RestaurantOrderLoyalty = SaleLoyaltySnapshot;

export interface RestaurantOrderDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId;
  orderNumber: string;
  type: RestaurantOrderType;
  tableId: Types.ObjectId | null;
  tableNameSnapshot: string;
  customerId: Types.ObjectId | null;
  customerNameSnapshot: string;
  items: RestaurantOrderLine[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  paidMinor: number;
  changeMinor: number;
  payments: RestaurantOrderPayment[];
  /** Kitchen tickets, in the order they were sent. */
  tickets: KitchenTicket[];
  /** The loyalty card this order was paid with. Null until it is paid, and for most orders. */
  loyalty: RestaurantOrderLoyalty | null;
  status: RestaurantOrderStatus;
  /** Money refunded against this order, and whether nothing is left to refund. */
  returnedTotalMinor?: number;
  fullyReturned?: boolean;
  note: string;
  /**
   * Bumped on every change to the lines. Payment only succeeds against the
   * revision the cashier saw, so an order cannot be paid while it is edited.
   */
  rev: number;
  openedBy: Types.ObjectId | null;
  openedByNameSnapshot: string;
  paidAt: Date | null;
  paidBy: Types.ObjectId | null;
  paidByNameSnapshot: string;
  /** The cash-drawer shift that was open when the order was paid, if any. */
  shiftId: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelReason: string;
}

const money = {
  type: Number,
  default: 0,
  min: 0,
  validate: { validator: Number.isSafeInteger, message: 'Amounts must be whole minor units' },
};

const lineSchema = new Schema<RestaurantOrderLine>({
  menuItemId: { type: Schema.Types.ObjectId, ref: 'MenuItem', required: true },
  nameSnapshot: { type: String, required: true },
  categorySnapshot: { type: String, default: '' },
  unitPriceMinor: { ...money, required: true },
  // 0 only for a voided line.
  quantity: { type: Number, required: true, min: 0, max: 999 },
  note: { type: String, default: '', maxlength: 200 },
  lineTotalMinor: { ...money, required: true },
  addedAt: { type: Date, default: () => new Date() },
  sentQuantity: { type: Number, default: 0, min: 0 },
  voidedAt: { type: Date, default: null },
  returnedQuantity: { type: Number, default: 0, min: 0 },
});

const ticketLineSchema = new Schema<KitchenTicketLine>(
  {
    lineId: { type: Schema.Types.ObjectId, required: true },
    nameSnapshot: { type: String, required: true },
    quantity: { type: Number, required: true },
    note: { type: String, default: '' },
  },
  { _id: false },
);

const ticketSchema = new Schema<KitchenTicket>({
  ticketNumber: { type: String, required: true },
  lines: { type: [ticketLineSchema], default: [] },
  status: { type: String, enum: [...KITCHEN_TICKET_STATUSES], default: 'pending' },
  createdAt: { type: Date, default: () => new Date() },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  createdByNameSnapshot: { type: String, default: '' },
  readyAt: { type: Date, default: null },
  readyByNameSnapshot: { type: String, default: '' },
});

const paymentSchema = new Schema<RestaurantOrderPayment>(
  {
    method: { type: String, required: true, trim: true, maxlength: 24 },
    methodLabel: { type: String, default: '' },
    amountMinor: { ...money, min: 1, required: true },
  },
  { _id: false },
);

const restaurantOrderSchema = new Schema<RestaurantOrderDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', required: true },
    orderNumber: { type: String, required: true },
    type: { type: String, enum: [...RESTAURANT_ORDER_TYPES], required: true },
    tableId: { type: Schema.Types.ObjectId, ref: 'DiningTable', default: null },
    tableNameSnapshot: { type: String, default: '' },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerNameSnapshot: { type: String, default: '' },
    items: { type: [lineSchema], default: [] },
    subtotalMinor: money,
    discountMinor: money,
    totalMinor: money,
    paidMinor: money,
    changeMinor: money,
    payments: { type: [paymentSchema], default: [] },
    tickets: { type: [ticketSchema], default: [] },
    loyalty: { type: saleLoyaltySchema(), default: null },
    status: { type: String, enum: [...RESTAURANT_ORDER_STATUSES], default: 'open' },
    returnedTotalMinor: { type: Number, default: 0, min: 0 },
    fullyReturned: { type: Boolean, default: false },
    note: { type: String, default: '', maxlength: 300 },
    rev: { type: Number, default: 0 },
    openedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    openedByNameSnapshot: { type: String, default: '' },
    paidAt: { type: Date, default: null },
    paidBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    paidByNameSnapshot: { type: String, default: '' },
    shiftId: { type: Schema.Types.ObjectId, ref: 'RestaurantShift', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, default: '' },
  },
  { timestamps: true },
);

restaurantOrderSchema.index({ tenantId: 1, storeId: 1, createdAt: -1 });
restaurantOrderSchema.index({ tenantId: 1, storeId: 1, status: 1, paidAt: -1 });
restaurantOrderSchema.index({ tenantId: 1, storeId: 1, orderNumber: 1 }, { unique: true });
// The Z-report: everything paid during one shift.
restaurantOrderSchema.index({ tenantId: 1, storeId: 1, shiftId: 1, status: 1 });
// The kitchen queue: orders in a branch that still have tickets in a given state.
restaurantOrderSchema.index({ tenantId: 1, storeId: 1, 'tickets.status': 1 });
// At most one OPEN order per table. The database enforces it, so two cashiers
// seating the same table at the same moment cannot both succeed.
restaurantOrderSchema.index(
  { tableId: 1 },
  { unique: true, partialFilterExpression: { status: 'open', tableId: { $type: 'objectId' } } },
);

export const RestaurantOrderModel = model<RestaurantOrderDoc>('RestaurantOrder', restaurantOrderSchema);
