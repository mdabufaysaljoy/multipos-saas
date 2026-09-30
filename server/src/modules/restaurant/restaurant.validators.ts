import { z } from 'zod';
import { RESTAURANT_ORDER_STATUSES, RESTAURANT_ORDER_TYPES } from '../../models/RestaurantOrder';
import { CASH_MOVEMENT_TYPES, SHIFT_STATUSES } from '../../models/RestaurantShift';
import { calendarDate, objectId, paginationSchema, searchSchema, paymentMethodKey } from '../common/common.validators';
import { posCustomerSchema } from '../customers/customers.validators';
import { dashboardRangeSchema } from '../reports/reports.validators';

const amount = z.number().int().min(0).max(100_000_000);

/** "true"/"false" from a query string. `z.coerce.boolean` would read "false" as true. */
const queryFlag = z.enum(['true', 'false']).optional().transform((value) => value === 'true');

// ------------------------------------------------------------------ menu

/**
 * A size or set of a dish. Exactly one is chosen and its price REPLACES the
 * dish's own - see `addOnGroupInput` for the other kind.
 */
const variantInput = z
  .object({
    /** Absent when the variant is being added; present when one is being edited. */
    _id: objectId.optional(),
    name: z.string().trim().min(1, 'Give the size a name').max(60),
    priceMinor: amount,
    sku: z.string().trim().max(40).optional().default(''),
    isAvailable: z.boolean().optional().default(true),
    sortOrder: z.number().int().min(0).max(10_000).optional().default(0),
  })
  .strict();

/** One extra. Several may be chosen and each price is ADDED to the line. */
const addOnInput = z
  .object({
    _id: objectId.optional(),
    name: z.string().trim().min(1, 'Give the extra a name').max(60),
    priceMinor: amount,
    isAvailable: z.boolean().optional().default(true),
    sortOrder: z.number().int().min(0).max(10_000).optional().default(0),
  })
  .strict();

const addOnGroupInput = z
  .object({
    _id: objectId.optional(),
    name: z.string().trim().min(1, 'Give the group a name').max(60),
    /** 1 or more makes the group a required choice. */
    minSelect: z.number().int().min(0).max(20).optional().default(0),
    maxSelect: z.number().int().min(1).max(20).optional().default(1),
    options: z.array(addOnInput).max(40),
    sortOrder: z.number().int().min(0).max(10_000).optional().default(0),
  })
  .strict()
  .refine((group) => group.maxSelect >= group.minSelect, {
    message: 'A group cannot require more extras than it allows',
    path: ['maxSelect'],
  })
  .refine((group) => group.options.length >= group.minSelect, {
    message: 'A group cannot require more extras than it offers',
    path: ['options'],
  });

export const createMenuItemSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(120),
    category: z.string().trim().min(1).max(60).optional().default('General'),
    /** Empty for a dish that sits directly under its section. */
    subcategory: z.string().trim().max(60).optional().default(''),
    description: z.string().trim().max(300).optional().default(''),
    priceMinor: amount,
    variants: z.array(variantInput).max(30).optional().default([]),
    addOnGroups: z.array(addOnGroupInput).max(10).optional().default([]),
    isAvailable: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export const updateMenuItemSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(60),
    subcategory: z.string().trim().max(60),
    description: z.string().trim().max(300),
    priceMinor: amount,
    variants: z.array(variantInput).max(30),
    addOnGroups: z.array(addOnGroupInput).max(10),
    isAvailable: z.boolean(),
    sortOrder: z.number().int().min(0).max(10_000),
  })
  .partial()
  .strict();

export const listMenuSchema = searchSchema.extend({
  category: z.string().trim().max(60).optional(),
  subcategory: z.string().trim().max(60).optional(),
  availableOnly: queryFlag,
});

// --------------------------------------------------------- subsections

const subcategoryName = z.string().trim().min(1, 'Give the subsection a name').max(60);

export const createSubcategorySchema = z
  .object({
    /** The section it belongs to. One level of nesting, no deeper. */
    category: z.string().trim().min(1, 'Choose a section').max(60),
    name: subcategoryName,
    sortOrder: z.number().int().min(0).max(1000).optional().default(0),
  })
  .strict();

export const updateSubcategorySchema = z
  .object({
    name: subcategoryName.optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

export const listSubcategoriesSchema = z
  .object({
    category: z.string().trim().max(60).optional(),
    includeInactive: queryFlag,
  })
  .strict();

export type CreateSubcategoryInput = z.infer<typeof createSubcategorySchema>;
export type UpdateSubcategoryInput = z.infer<typeof updateSubcategorySchema>;
export type ListSubcategoriesInput = z.infer<typeof listSubcategoriesSchema>;

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
    /**
     * Which size or set. Required when the dish has variants, refused when it
     * has none - the service decides, because only it can see the menu.
     */
    variantId: objectId.optional(),
    /** The extras chosen, by option id. The service prices them. */
    addOnOptionIds: z.array(objectId).max(20).optional().default([]),
    quantity: z.number().int().min(1).max(999),
    note: z.string().trim().max(200).optional().default(''),
  })
  .strict();

export const createOrderSchema = z
  .object({
    type: z.enum(RESTAURANT_ORDER_TYPES),
    tableId: objectId.optional(),
    customerId: objectId.optional(),
    customer: posCustomerSchema.optional(),
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
            method: paymentMethodKey,
            amountMinor: z.number().int().min(1).max(100_000_000),
          })
          .strict(),
      )
      .min(1, 'Add a payment')
      .max(6),
    discountMinor: amount.default(0),
    /** The revision the cashier is paying for; stale edits are refused. */
    rev: z.number().int().min(0),
    /**
     * The loyalty card scanned at the till. Only a scanned card earns or
     * redeems - never a phone number, and never a customer on their own.
     */
    loyaltyMembershipId: objectId.optional(),
    redeemPoints: z.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export const cancelOrderSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) }).strict();

/** Sends the changes the kitchen has not seen, for the revision on screen. */
export const sendToKitchenSchema = z.object({ rev: z.number().int().min(0) }).strict();

export const ticketParams = z.object({ id: objectId, ticketId: objectId });

export const listOrdersSchema = paginationSchema.extend({
  status: z.enum(RESTAURANT_ORDER_STATUSES).optional(),
  type: z.enum(RESTAURANT_ORDER_TYPES).optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});

/** Every vertical's dashboard takes the same range; this is that schema. */
export const dashboardSchema = dashboardRangeSchema;

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
export type OpenShiftInput = z.infer<typeof openShiftSchema>;
export type CashMovementInput = z.infer<typeof cashMovementSchema>;
export type CloseShiftInput = z.infer<typeof closeShiftSchema>;
export type ListShiftsInput = z.infer<typeof listShiftsSchema>;
