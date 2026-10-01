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
import { posImportRouter } from '../posImports/posImports.routes';
import { createCategory, listCategories, removeCategory, updateCategory } from '../posCategories/posCategories.controller';
import { createPosCategorySchema, listPosCategoriesSchema, updatePosCategorySchema } from '../../services/catalogue/posCategories.service';
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
  createAddOnSchema,
  listAddOnsSchema,
  updateAddOnSchema,
  createSubcategorySchema,
  listSubcategoriesSchema,
  updateSubcategorySchema,
  createOrderSchema,
  createTableSchema,
  dashboardSchema,
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
// The departments this workspace sells under; the same four routes in every POS
// type whose items carry the category as a name (see services/catalogue).
router.get('/categories', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ query: listPosCategoriesSchema }), listCategories);
router.post(
  '/categories',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CATEGORIES_CREATE),
  validate({ body: createPosCategorySchema }),
  createCategory,
);
router.patch(
  '/categories/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CATEGORIES_EDIT),
  validate({ params: idParam, body: updatePosCategorySchema }),
  updateCategory,
);
router.delete(
  '/categories/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CATEGORIES_DELETE),
  validate({ params: idParam }),
  removeCategory,
);

// Subsections of a section. Managed with the SAME permissions as the section
// list above, because they are one list, one level apart.
router.get('/subcategories', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ query: listSubcategoriesSchema }), controller.listSubcategories);
router.post(
  '/subcategories',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CATEGORIES_CREATE),
  validate({ body: createSubcategorySchema }),
  controller.createSubcategory,
);
router.patch(
  '/subcategories/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CATEGORIES_EDIT),
  validate({ params: idParam, body: updateSubcategorySchema }),
  controller.updateSubcategory,
);
router.delete(
  '/subcategories/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CATEGORIES_DELETE),
  validate({ params: idParam }),
  controller.removeSubcategory,
);

// The reusable extras. They carry a price, so they are managed with the same
// permissions as the dishes that offer them, not with the name lists.
router.get('/addons', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ query: listAddOnsSchema }), controller.listAddOns);
router.post('/addons', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_CREATE), validate({ body: createAddOnSchema }), controller.createAddOn);
router.patch(
  '/addons/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.PRODUCTS_EDIT),
  validate({ params: idParam, body: updateAddOnSchema }),
  controller.updateAddOn,
);
router.delete('/addons/:id', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_DELETE), validate({ params: idParam }), controller.removeAddOn);

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
// ------------------------------------------------ order tokens & printing
// Sending an order produces its token (a KOT number) and changes the order, so
// it needs sales.create. Reprinting a token or a receipt only reads: sales.view.
router.post('/orders/:id/send-to-kitchen', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ params: idParam, body: sendToKitchenSchema }), controller.sendToKitchen);
router.get('/orders/:id/tickets/:ticketId', requirePermission(PERMISSIONS.SALES_VIEW), validate({ params: ticketParams }), controller.kitchenTicket);
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

// The same report as a PDF. Printing what the page already shows is part of
// the report, so it is gated by the report's own permission and plan feature -
// not by Data export, which hands over the underlying rows and is sold apart.
router.get(
  '/reports/print',
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  requireEntitlement('advancedAnalytics'),
  validate({ query: restaurantReportsSchema }),
  controller.printReports,
);

// A restaurant keeps no stock, so this always answers with an empty page -
// the same route and the same shape as every other vertical.
router.get('/stock-ledger', requirePermission(PERMISSIONS.INVENTORY_VIEW), validate({ query: posLedgerQuerySchema }), stockLedger);

router.get('/summary', requirePermission(PERMISSIONS.REPORTS_VIEW), validate({ query: summarySchema }), controller.summary);
// The Restaurant dashboard: on every plan, like the Clothing dashboard.
router.get('/dashboard', requirePermission(PERMISSIONS.REPORTS_VIEW), validate({ query: dashboardSchema }), controller.dashboard);

// Bulk import of this vertical's catalogue; the same two-step flow Clothing has.
router.use('/imports', posImportRouter());

export default router;
