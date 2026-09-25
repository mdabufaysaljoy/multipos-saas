import { requireEntitlement } from '../../middleware/access';
import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireActiveSubscription, requireSubscribedAccess } from '../../middleware/subscription';
import { analyticsRangeSchema, dashboardRangeSchema } from '../reports/reports.validators';
import { requireVertical } from '../../middleware/vertical';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './supershop.controller';
import {
  adjustStockSchema,
  barcodeQuerySchema,
  createProductSchema,
  createSaleSchema,
  listMovementsSchema,
  listProductsSchema,
  listSalesSchema,
  receiveStockSchema,
  updateProductSchema,
  createReturnSchema,
  voidSaleSchema,
} from './supershop.validators';
import { posLedgerQuerySchema } from '../../services/inventory/posLedger';
import { stockLedger } from '../inventory/stockLedger.controller';
import { posImportRouter } from '../posImports/posImports.routes';
import { createCategory, listCategories, removeCategory, updateCategory } from '../posCategories/posCategories.controller';
import { createPosCategorySchema, listPosCategoriesSchema, updatePosCategorySchema } from '../../services/catalogue/posCategories.service';

const router = Router();

/**
 * Supershop workspaces only, subscribed, and every write needs an active plan.
 * Permissions reuse the existing keys so staff roles work unchanged:
 *   products        -> products.*
 *   stock, ledger   -> inventory.view / inventory.adjust
 *   sales           -> sales.create / sales.view / sales.cancel (void) / sales.discount
 *   dashboard       -> reports.view
 */
router.use(authenticate, resolveTenant, requireVertical('supershop'), requireSubscribedAccess);

// -------------------------------------------------------------- products
router.get('/products', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ query: listProductsSchema }), controller.listProducts);
// Registered before `/products/:id` so "lookup" is never read as an id.
router.get('/products/lookup', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ query: barcodeQuerySchema }), controller.lookupBarcode);
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
router.post('/products', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_CREATE), validate({ body: createProductSchema }), controller.createProduct);
router.get('/products/:id', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: idParam }), controller.getProduct);
router.patch('/products/:id', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_EDIT), validate({ params: idParam, body: updateProductSchema }), controller.updateProduct);
router.delete('/products/:id', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_DELETE), validate({ params: idParam }), controller.removeProduct);

// ----------------------------------------------------------------- stock
router.post('/products/:id/stock', requireActiveSubscription, requirePermission(PERMISSIONS.INVENTORY_ADJUST), validate({ params: idParam, body: receiveStockSchema }), controller.receiveStock);
router.post('/products/:id/adjust', requireActiveSubscription, requirePermission(PERMISSIONS.INVENTORY_ADJUST), validate({ params: idParam, body: adjustStockSchema }), controller.adjustStock);
router.get('/movements', requirePermission(PERMISSIONS.INVENTORY_VIEW), validate({ query: listMovementsSchema }), controller.listMovements);
router.get('/inventory-summary', requirePermission(PERMISSIONS.INVENTORY_VIEW), controller.inventorySummary);
// The same ledger in the shape every vertical reports; see services/inventory/posLedger.
router.get('/stock-ledger', requirePermission(PERMISSIONS.INVENTORY_VIEW), validate({ query: posLedgerQuerySchema }), stockLedger);

// ----------------------------------------------------------------- sales
router.post('/sales', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ body: createSaleSchema }), controller.createSale);
router.get('/sales', requirePermission(PERMISSIONS.SALES_VIEW), validate({ query: listSalesSchema }), controller.listSales);
router.get('/sales/:id', requirePermission(PERMISSIONS.SALES_VIEW), validate({ params: idParam }), controller.getSale);
router.get('/sales/:id/receipt', requirePermission(PERMISSIONS.SALES_VIEW), validate({ params: idParam }), controller.receipt);
router.post('/sales/:id/void', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CANCEL), validate({ params: idParam, body: voidSaleSchema }), controller.voidSale);
// A return against a completed sale: partial or whole, refunded on a tender
// the branch takes, with the goods restocked unless the till says otherwise.
router.post(
  '/sales/:id/return',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.RETURNS_CREATE),
  validate({ params: idParam, body: createReturnSchema }),
  controller.createReturn,
);
router.get('/returns', requirePermission(PERMISSIONS.RETURNS_VIEW), validate({ query: listSalesSchema }), controller.listReturns);

router.get('/dashboard', requirePermission(PERMISSIONS.REPORTS_VIEW), validate({ query: dashboardRangeSchema }), controller.dashboard);

// Supershop Advanced Analytics: RBAC AND the plan feature, same gate as the other verticals.
router.get(
  '/reports',
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  requireEntitlement('advancedAnalytics'),
  validate({ query: analyticsRangeSchema }),
  controller.reports,
);

// Bulk import of this vertical's catalogue; the same two-step flow Clothing has.
router.use('/imports', posImportRouter());

export default router;
