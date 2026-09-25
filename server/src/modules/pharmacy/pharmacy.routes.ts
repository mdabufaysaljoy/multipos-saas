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
import * as controller from './pharmacy.controller';
import {
  adjustBatchSchema,
  createMedicineSchema,
  createSaleSchema,
  listBatchesSchema,
  listMedicinesSchema,
  listMovementsSchema,
  listSalesSchema,
  receiveBatchSchema,
  updateMedicineSchema,
  createReturnSchema,
  voidSaleSchema,
} from './pharmacy.validators';
import { posLedgerQuerySchema } from '../../services/inventory/posLedger';
import { stockLedger } from '../inventory/stockLedger.controller';
import { createCategory, listCategories, removeCategory, updateCategory } from '../posCategories/posCategories.controller';
import { createPosCategorySchema, listPosCategoriesSchema, updatePosCategorySchema } from '../../services/catalogue/posCategories.service';

const router = Router();

/**
 * Pharmacy workspaces only, subscribed, and every write needs an active plan.
 * Permissions reuse the existing keys so staff roles work unchanged:
 *   medicines        -> products.*
 *   batches, ledger  -> inventory.view / inventory.adjust
 *   sales            -> sales.create / sales.view / sales.cancel (void) / sales.discount
 *   dashboard        -> reports.view
 */
router.use(authenticate, resolveTenant, requireVertical('pharmacy'), requireSubscribedAccess);

// ------------------------------------------------------------- medicines
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

router.get('/medicines', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ query: listMedicinesSchema }), controller.listMedicines);
router.post('/medicines', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_CREATE), validate({ body: createMedicineSchema }), controller.createMedicine);
router.get('/medicines/:id', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: idParam }), controller.getMedicine);
router.patch('/medicines/:id', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_EDIT), validate({ params: idParam, body: updateMedicineSchema }), controller.updateMedicine);
router.delete('/medicines/:id', requireActiveSubscription, requirePermission(PERMISSIONS.PRODUCTS_DELETE), validate({ params: idParam }), controller.removeMedicine);

// ----------------------------------------------------------------- stock
router.post('/medicines/:id/batches', requireActiveSubscription, requirePermission(PERMISSIONS.INVENTORY_ADJUST), validate({ params: idParam, body: receiveBatchSchema }), controller.receiveBatch);
router.get('/batches', requirePermission(PERMISSIONS.INVENTORY_VIEW), validate({ query: listBatchesSchema }), controller.listBatches);
router.post('/batches/:id/adjust', requireActiveSubscription, requirePermission(PERMISSIONS.INVENTORY_ADJUST), validate({ params: idParam, body: adjustBatchSchema }), controller.adjustBatch);
router.get('/movements', requirePermission(PERMISSIONS.INVENTORY_VIEW), validate({ query: listMovementsSchema }), controller.listMovements);
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

// The Pharmacy dashboard: on every plan, like the other verticals' dashboards.
router.get('/dashboard', requirePermission(PERMISSIONS.REPORTS_VIEW), validate({ query: dashboardRangeSchema }), controller.dashboard);

// Pharmacy Advanced Analytics: RBAC AND the plan feature, same gate as the other verticals.
router.get(
  '/reports',
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  requireEntitlement('advancedAnalytics'),
  validate({ query: analyticsRangeSchema }),
  controller.reports,
);

export default router;
