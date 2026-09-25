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
  createExchangeSchema,
  holdSaleSchema,
  voidSaleSchema,
} from './supershop.validators';
import { posLedgerQuerySchema } from '../../services/inventory/posLedger';
import { stockLedger } from '../inventory/stockLedger.controller';
import { posImportRouter } from '../posImports/posImports.routes';
import { createCategory, listCategories, removeCategory, updateCategory } from '../posCategories/posCategories.controller';
import { createPosCategorySchema, listPosCategoriesSchema, updatePosCategorySchema } from '../../services/catalogue/posCategories.service';
import { createShopBrandSchema, listShopBrandsSchema, updateShopBrandSchema } from '../../services/catalogue/shopBrands.service';

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
// The brands the shop sells under. Independent of the department: a product
// has both, either or neither. Managed with the same permissions a department
// is, because it is the same kind of setting.
router.get('/brands', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ query: listShopBrandsSchema }), controller.listBrands);
router.post(
  '/brands',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CATEGORIES_CREATE),
  validate({ body: createShopBrandSchema }),
  controller.createBrand,
);
router.patch(
  '/brands/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CATEGORIES_EDIT),
  validate({ params: idParam, body: updateShopBrandSchema }),
  controller.updateBrand,
);
router.delete(
  '/brands/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CATEGORIES_DELETE),
  validate({ params: idParam }),
  controller.removeBrand,
);
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
// An exchange against a completed sale: the returned goods pay for replacement
// goods and the customer settles the difference. It creates a sale as well as a
// return, so the engine checks `sales.create` on top of this.
router.post(
  '/sales/:id/exchange',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.RETURNS_CREATE),
  validate({ params: idParam, body: createExchangeSchema }),
  controller.createExchange,
);
router.get('/returns', requirePermission(PERMISSIONS.RETURNS_VIEW), validate({ query: listSalesSchema }), controller.listReturns);

// ----------------------------------------------------------- held sales
// A basket put aside. Nothing here completes a sale, so nothing here needs an
// active subscription beyond the one the module already requires - but holding
// is part of taking a sale, so it follows `sales.create`.
router.post('/held-sales', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ body: holdSaleSchema }), controller.holdSale);
router.get('/held-sales', requirePermission(PERMISSIONS.SALES_VIEW), controller.listHeldSales);
router.post('/held-sales/:id/resume', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ params: idParam }), controller.resumeHeldSale);
// Discarding your own needs only that; discarding someone else's needs
// `sales.cancel`, which the service checks.
router.delete('/held-sales/:id', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ params: idParam }), controller.removeHeldSale);

router.get('/dashboard', requirePermission(PERMISSIONS.REPORTS_VIEW), validate({ query: dashboardRangeSchema }), controller.dashboard);

// Supershop Advanced Analytics: RBAC AND the plan feature, same gate as the other verticals.
router.get(
  '/reports',
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  requireEntitlement('advancedAnalytics'),
  validate({ query: analyticsRangeSchema }),
  controller.reports,
);

// The same report as a PDF. Printing what the page already shows is part of
// the report, so it is gated by the report's own permission and plan feature -
// not by Data export, which hands over the underlying rows and is sold apart.
router.get(
  '/reports/print',
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  requireEntitlement('advancedAnalytics'),
  validate({ query: analyticsRangeSchema }),
  controller.printReports,
);

// Bulk import of this vertical's catalogue; the same two-step flow Clothing has.
router.use('/imports', posImportRouter());

export default router;
