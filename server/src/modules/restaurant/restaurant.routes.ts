import { requireEntitlement } from '../../middleware/access';
import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireActiveSubscription, requireSubscribedAccess } from '../../middleware/subscription';
import { requireVertical } from '../../middleware/vertical';
import { validate } from '../../middleware/validate';
import { posLedgerQuerySchema } from '../../services/inventory/posLedger';
import { stockLedger } from '../inventory/stockLedger.controller';
import { idParam } from '../common/common.validators';
import * as controller from './restaurant.controller';
import {
  addItemsSchema,
  cancelOrderSchema,
  cashMovementSchema,
  closeShiftSchema,
  listShiftsSchema,
  openShiftSchema,
  restaurantReportsSchema,
  createMenuItemSchema,
  createOrderSchema,
  createOrderReturnSchema,
  createTableSchema,
  dashboardSchema,
  kitchenQueueSchema,
  sendToKitchenSchema,
  ticketParams,
  lineParams,
  listMenuSchema,
  listOrdersSchema,
  payOrderSchema,
  summarySchema,
  updateLineSchema,
  updateMenuItemSchema,
  updateTableSchema,
} from './restaurant.validators';

const router = Router();

/**
 * Restaurant workspaces only, subscribed, and every write needs an active plan.
 * Permissions reuse the existing keys so staff roles work unchanged:
 *   menu    -> products.*        tables (edit) -> settings.edit
 *   orders  -> sales.create / sales.view / sales.cancel / sales.discount
 *   summary -> reports.view
 */
router.use(authenticate, resolveTenant, requireVertical('restaurant'), requireSubscribedAccess);

// ------------------------------------------------------------------ menu
router.get('/menu', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ query: listMenuSchema }), controller.listMenu);
router.post('/menu', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_CREATE), validate({ body: createMenuItemSchema }), controller.createMenuItem);
router.patch('/menu/:id', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_EDIT), validate({ params: idParam, body: updateMenuItemSchema }), controller.updateMenuItem);
router.delete('/menu/:id', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_DELETE), validate({ params: idParam }), controller.removeMenuItem);

// ---------------------------------------------------------------- tables
// Anyone taking orders needs to see the floor.
router.get('/tables', requirePermission(PERMISSIONS.SALES_CREATE), controller.listTables);
router.post('/tables', requireActiveSubscription, requirePermission(PERMISSIONS.SETTINGS_EDIT), validate({ body: createTableSchema }), controller.createTable);
router.patch('/tables/:id', requireActiveSubscription, requirePermission(PERMISSIONS.SETTINGS_EDIT), validate({ params: idParam, body: updateTableSchema }), controller.updateTable);
router.delete('/tables/:id', requireActiveSubscription, requirePermission(PERMISSIONS.SETTINGS_EDIT), validate({ params: idParam }), controller.removeTable);

// ---------------------------------------------------------------- orders
router.get('/orders', requirePermission(PERMISSIONS.SALES_VIEW), validate({ query: listOrdersSchema }), controller.listOrders);
router.get('/orders/:id', requirePermission(PERMISSIONS.SALES_VIEW), validate({ params: idParam }), controller.getOrder);
router.post('/orders', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ body: createOrderSchema }), controller.createOrder);
router.post('/orders/:id/items', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ params: idParam, body: addItemsSchema }), controller.addItems);
router.patch('/orders/:id/items/:lineId', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ params: lineParams, body: updateLineSchema }), controller.updateLine);
router.delete('/orders/:id/items/:lineId', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ params: lineParams }), controller.removeLine);
router.post('/orders/:id/pay', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ params: idParam, body: payOrderSchema }), controller.payOrder);
router.post('/orders/:id/cancel', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CANCEL), validate({ params: idParam, body: cancelOrderSchema }), controller.cancelOrder);
// A refund against a PAID order: money back, nothing restocked. An open order
// is changed or cancelled instead, which is a different thing.
router.post(
  '/orders/:id/return',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.RETURNS_CREATE),
  validate({ params: idParam, body: createOrderReturnSchema }),
  controller.createOrderReturn,
);
router.get('/returns', requirePermission(PERMISSIONS.RETURNS_VIEW), validate({ query: listOrdersSchema }), controller.listOrderReturns);

// ------------------------------------------------ kitchen tickets & printing
// Reading the queue, tickets and receipts needs sales.view; sending a ticket or
// marking one ready changes the order, so it needs sales.create.
router.post('/orders/:id/send-to-kitchen', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ params: idParam, body: sendToKitchenSchema }), controller.sendToKitchen);
router.get('/kitchen/tickets', requirePermission(PERMISSIONS.SALES_VIEW), validate({ query: kitchenQueueSchema }), controller.kitchenQueue);
router.get('/orders/:id/tickets/:ticketId', requirePermission(PERMISSIONS.SALES_VIEW), validate({ params: ticketParams }), controller.kitchenTicket);
router.post('/orders/:id/tickets/:ticketId/ready', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ params: ticketParams }), controller.markTicketReady);
router.get('/orders/:id/receipt', requirePermission(PERMISSIONS.SALES_VIEW), validate({ params: idParam }), controller.receipt);

// ------------------------------------------------ cash-drawer shifts
// Running the drawer is part of taking orders (sales.create). Shift history
// and past Z-reports are reporting (reports.view). Closing with a variance is
// audited; a closed shift is final.
router.get('/shifts/current', requirePermission(PERMISSIONS.SALES_CREATE), controller.currentShift);
router.post('/shifts', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ body: openShiftSchema }), controller.openShift);
router.post('/shifts/:id/cash-movements', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ params: idParam, body: cashMovementSchema }), controller.addCashMovement);
router.post('/shifts/:id/close', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ params: idParam, body: closeShiftSchema }), controller.closeShift);
router.get('/shifts', requirePermission(PERMISSIONS.REPORTS_VIEW), validate({ query: listShiftsSchema }), controller.listShifts);
router.get('/shifts/:id', requirePermission(PERMISSIONS.REPORTS_VIEW), validate({ params: idParam }), controller.getShift);

// Restaurant Advanced Analytics: RBAC AND the plan feature, same code as Clothing.
router.get(
  '/reports',
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  requireEntitlement('advancedAnalytics'),
  validate({ query: restaurantReportsSchema }),
  controller.reports,
);

// A restaurant keeps no stock, so this always answers with an empty page -
// the same route and the same shape as every other vertical.
router.get('/stock-ledger', requirePermission(PERMISSIONS.INVENTORY_VIEW), validate({ query: posLedgerQuerySchema }), stockLedger);

router.get('/summary', requirePermission(PERMISSIONS.REPORTS_VIEW), validate({ query: summarySchema }), controller.summary);
// The Restaurant dashboard: on every plan, like the Clothing dashboard.
router.get('/dashboard', requirePermission(PERMISSIONS.REPORTS_VIEW), validate({ query: dashboardSchema }), controller.dashboard);

export default router;
