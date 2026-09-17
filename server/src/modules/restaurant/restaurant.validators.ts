import { z } from 'zod';
import { PAYMENT_METHODS } from '../../config/constants';
import { RESTAURANT_ORDER_STATUSES, RESTAURANT_ORDER_TYPES } from '../../models/RestaurantOrder';
import { CASH_MOVEMENT_TYPES, SHIFT_STATUSES } from '../../models/RestaurantShift';
import { calendarDate, objectId, paginationSchema, searchSchema } from '../common/common.validators';
import { RANGE_PRESETS } from '../reports/reports.validators';

const amount = z.number().int().min(0).max(100_000_000);

/** "true"/"false" from a query string. `z.coerce.boolean` would read "false" as true. */
const queryFlag = z.enum(['true', 'false']).optional().transform((value) => value === 'true');

// ------------------------------------------------------------------ menu

export const createMenuItemSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(120),
    category: z.string().trim().min(1).max(60).optional().default('General'),
    description: z.string().trim().max(300).optional().default(''),
    priceMinor: amount,
    isAvailable: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export const updateMenuItemSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(60),
    description: z.string().trim().max(300),
    priceMinor: amount,
    isAvailable: z.boolean(),
    sortOrder: z.number().int().min(0).max(10_000),
  })
  .partial()
  .strict();

export const listMenuSchema = searchSchema.extend({
  category: z.string().trim().max(60).optional(),
  availableOnly: queryFlag,
});

// ---------------------------------------------------------------- tables

export const createTableSchema = z
  .object({
    name: z.string().trim().min(1, 'Table name is required').max(40),
    seats: z.number().int().min(1).max(50).default(4),
  })
  .strict();

export const updateTableSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    seats: z.number().int().min(1).max(50),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

// ---------------------------------------------------------------- orders

/**
 * An order line names a menu item and a quantity - nothing else. `.strict()`
 * rejects a client-supplied price outright; prices only ever come from the menu.
 */
const lineInput = z
  .object({
    menuItemId: objectId,
    quantity: z.number().int().min(1).max(999),
    note: z.string().trim().max(200).optional().default(''),
  })
  .strict();

export const createOrderSchema = z
  .object({
    type: z.enum(RESTAURANT_ORDER_TYPES),
    tableId: objectId.optional(),
    customerId: objectId.optional(),
    items: z.array(lineInput).min(1, 'Add at least one item').max(100),
    note: z.string().trim().max(300).optional().default(''),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.type === 'dine_in' && !data.tableId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tableId'], message: 'Choose a table for a dine-in order' });
    }
    if (data.type === 'takeaway' && data.tableId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tableId'], message: 'A takeaway order has no table' });
    }
  });

export const addItemsSchema = z.object({ items: z.array(lineInput).min(1).max(100) }).strict();

export const updateLineSchema = z.object({ quantity: z.number().int().min(1).max(999) }).strict();

export const lineParams = z.object({ id: objectId, lineId: objectId });

export const payOrderSchema = z
  .object({
    payments: z
      .array(
        z
          .object({
            method: z.enum(PAYMENT_METHODS),
            amountMinor: z.number().int().min(1).max(100_000_000),
          })
          .strict(),
      )
      .min(1, 'Add a payment')
      .max(6),
    discountMinor: amount.default(0),
    /** The revision the cashier is paying for; stale edits are refused. */
    rev: z.number().int().min(0),
  })
  .strict();

export const cancelOrderSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) }).strict();

/** Sends the changes the kitchen has not seen, for the revision on screen. */
export const sendToKitchenSchema = z.object({ rev: z.number().int().min(0) }).strict();

export const ticketParams = z.object({ id: objectId, ticketId: objectId });

export const kitchenQueueSchema = z.object({
  status: z.enum(['pending', 'ready']).default('pending'),
});

export const listOrdersSchema = paginationSchema.extend({
  status: z.enum(RESTAURANT_ORDER_STATUSES).optional(),
  type: z.enum(RESTAURANT_ORDER_TYPES).optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});

/** Same presets and custom-range rules as the Clothing dashboard. */
export const dashboardSchema = z
  .object({
    preset: z.enum(RANGE_PRESETS).default('today'),
    from: calendarDate.optional(),
    to: calendarDate.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.preset === 'custom' && (!data.from || !data.to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'A custom range needs both a start and an end date' });
    }
    if (data.from && data.to && data.from > data.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'The end date must be after the start date' });
    }
  });

// ---------------------------------------------------------------- shifts

export const openShiftSchema = z
  .object({
    openingFloatMinor: amount,
    note: z.string().trim().max(300).optional().default(''),
  })
  .strict();

export const cashMovementSchema = z
  .object({
    type: z.enum(CASH_MOVEMENT_TYPES),
    amountMinor: z.number().int().min(1).max(100_000_000),
    reason: z.string().trim().min(3, 'Give a reason').max(200),
  })
  .strict();

/** The cashier states what they counted; the server works out what was expected. */
export const closeShiftSchema = z
  .object({
    countedCashMinor: amount,
    note: z.string().trim().max(300).optional().default(''),
  })
  .strict();

export const listShiftsSchema = paginationSchema.extend({
  status: z.enum(SHIFT_STATUSES).optional(),
});

/** Restaurant Advanced Analytics: the same range rules as the dashboard. */
export const restaurantReportsSchema = dashboardSchema;

export const summarySchema = z.object({
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});

export type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>;
export type UpdateMenuItemInput = z.infer<typeof updateMenuItemSchema>;
export type ListMenuInput = z.infer<typeof listMenuSchema>;
export type CreateTableInput = z.infer<typeof createTableSchema>;
export type UpdateTableInput = z.infer<typeof updateTableSchema>;
export type OrderLineInput = z.infer<typeof lineInput>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type PayOrderInput = z.infer<typeof payOrderSchema>;
export type ListOrdersInput = z.infer<typeof listOrdersSchema>;
export type SummaryInput = z.infer<typeof summarySchema>;
export type DashboardInput = z.infer<typeof dashboardSchema>;
export type KitchenQueueInput = z.infer<typeof kitchenQueueSchema>;
export type OpenShiftInput = z.infer<typeof openShiftSchema>;
export type CashMovementInput = z.infer<typeof cashMovementSchema>;
export type CloseShiftInput = z.infer<typeof closeShiftSchema>;
export type ListShiftsInput = z.infer<typeof listShiftsSchema>;
