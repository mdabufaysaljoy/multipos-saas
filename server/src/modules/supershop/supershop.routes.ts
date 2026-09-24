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
  voidSaleSchema,
} from './supershop.validators';
import { posLedgerQuerySchema } from '../../services/inventory/posLedger';
import { stockLedger } from '../inventory/stockLedger.controller';

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
router.get('/categories', requirePermission(PERMISSIONS.PRODUCTS_VIEW), controller.categories);
router.post('/products', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_CREATE), validate({ body: createProductSchema }), controller.createProduct);
router.get('/products/:id', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: idParam }), controller.getProduct);
router.patch('/products/:id', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_EDIT), validate({ params: idParam, body: updateProductSchema }), controller.updateProduct);
router.delete('/products/:id', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_DELETE), validate({ params: idParam }), controller.removeProduct);

// ----------------------------------------------------------------- stock
router.post('/products/:id/stock', requireActiveSubscription, requirePermission(PERMISSIONS.INVENTORY_ADJUST), validate({ params: idParam, body: receiveStockSchema }), controller.receiveStock);
router.post('/products/:id/adjust', requireActiveSubscription, requirePermission(PERMISSIONS.INVENTORY_ADJUST), validate({ params: idParam, body: adjustStockSchema }), controller.adjustStock);
router.get('/movements', requirePermission(PERMISSIONS.INVENTORY_VIEW), validate({ query: listMovementsSchema }), controller.listMovements);
// The same ledger in the shape every vertical reports; see services/inventory/posLedger.
router.get('/stock-ledger', requirePermission(PERMISSIONS.INVENTORY_VIEW), validate({ query: posLedgerQuerySchema }), stockLedger);

// ----------------------------------------------------------------- sales
router.post('/sales', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CREATE), validate({ body: createSaleSchema }), controller.createSale);
router.get('/sales', requirePermission(PERMISSIONS.SALES_VIEW), validate({ query: listSalesSchema }), controller.listSales);
router.get('/sales/:id', requirePermission(PERMISSIONS.SALES_VIEW), validate({ params: idParam }), controller.getSale);
router.get('/sales/:id/receipt', requirePermission(PERMISSIONS.SALES_VIEW), validate({ params: idParam }), controller.receipt);
router.post('/sales/:id/void', requireActiveSubscription, requirePermission(PERMISSIONS.SALES_CANCEL), validate({ params: idParam, body: voidSaleSchema }), controller.voidSale);

router.get('/dashboard', requirePermission(PERMISSIONS.REPORTS_VIEW), validate({ query: dashboardRangeSchema }), controller.dashboard);

// Supershop Advanced Analytics: RBAC AND the plan feature, same gate as the other verticals.
router.get(
  '/reports',
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  requireEntitlement('advancedAnalytics'),
  validate({ query: analyticsRangeSchema }),
  controller.reports,
);

export default router;
