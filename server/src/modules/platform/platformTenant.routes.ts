import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePlatformAdmin } from '../../middleware/auth';
import { resolvePlatformTenant } from '../../middleware/platformTenant';
import { validate } from '../../middleware/validate';
import { idParam, objectId } from '../common/common.validators';

// Reuse the tenant-side controllers verbatim. They read `req.ctx`, which
// `resolvePlatformTenant` supplies - so there is exactly ONE product service,
// one category service and one staff service in the codebase.
import * as productsController from '../products/products.controller';
import * as categoriesController from '../categories/categories.controller';
import * as staffController from '../staff/staff.controller';
import * as rolesController from '../roles/roles.controller';
import * as storesController from '../stores/stores.controller';
import * as inventoryController from '../inventory/inventory.controller';
import * as salesController from '../sales/sales.controller';
import * as reportsController from '../reports/reports.controller';

import {
  createProductSchema,
  createVariantSchema,
  listProductsSchema,
  updateProductSchema,
  updateVariantSchema,
} from '../products/products.validators';
import { createCategorySchema, listCategoriesSchema, updateCategorySchema } from '../categories/categories.validators';
import { createStaffSchema, listStaffSchema, resetStaffPasswordSchema, updateStaffSchema } from '../staff/staff.validators';
import { createRoleSchema, updateRoleSchema } from '../roles/roles.validators';
import { createStoreSchema, updateStoreSchema } from '../stores/stores.validators';
import { adjustStockSchema, listStockSchema } from '../inventory/inventory.validators';
import { listSalesSchema } from '../sales/sales.validators';
import { reportRangeSchema } from '../reports/reports.validators';
import * as controller from './platformTenant.controller';

/**
 * Platform-admin management of a NAMED workspace.
 *
 * Mounted at /api/platform/workspaces/:tenantId/* so the target tenant is part
 * of the URL and can never be implicit. Every route requires the platform-admin
 * role first, then resolves the workspace context explicitly.
 */
const router = Router({ mergeParams: true });

router.use(authenticate, requirePlatformAdmin, resolvePlatformTenant);

const variantParams = z.object({ tenantId: objectId, id: objectId, variantId: objectId });
const withTenant = (shape: z.ZodTypeAny) => shape;

// ----------------------------------------------------------------- overview
router.get('/overview', controller.workspaceOverview);
router.get('/analytics', validate({ query: reportRangeSchema }), reportsController.salesAndProfit);

// ------------------------------------------------------------------- stores
router.get('/stores', controller.listStores);
router.post('/stores', validate({ body: createStoreSchema }), controller.createStore);
router.patch('/stores/:id', validate({ params: z.object({ tenantId: objectId, id: objectId }), body: updateStoreSchema }), storesController.update);
router.post('/stores/:id/make-default', validate({ params: z.object({ tenantId: objectId, id: objectId }) }), storesController.makeDefault);
router.delete('/stores/:id', validate({ params: z.object({ tenantId: objectId, id: objectId }) }), controller.auditedDeleteStore);

// ----------------------------------------------------------------- products
router.get('/products', validate({ query: withTenant(listProductsSchema) }), productsController.list);
router.get('/products/:id', validate({ params: z.object({ tenantId: objectId, id: objectId }) }), productsController.getOne);
router.post('/products', validate({ body: createProductSchema }), controller.auditedCreateProduct);
router.patch('/products/:id', validate({ params: z.object({ tenantId: objectId, id: objectId }), body: updateProductSchema }), controller.auditedUpdateProduct);
router.delete('/products/:id', validate({ params: z.object({ tenantId: objectId, id: objectId }) }), controller.auditedDeleteProduct);
router.post('/products/:id/variants', validate({ params: z.object({ tenantId: objectId, id: objectId }), body: createVariantSchema }), productsController.addVariant);
router.patch('/products/:id/variants/:variantId', validate({ params: variantParams, body: updateVariantSchema }), productsController.updateVariant);
router.delete('/products/:id/variants/:variantId', validate({ params: variantParams }), productsController.removeVariant);
router.post('/products/barcode/generate', productsController.generateBarcode);

// --------------------------------------------------------------- categories
router.get('/categories', validate({ query: listCategoriesSchema }), categoriesController.list);
router.post('/categories', validate({ body: createCategorySchema }), categoriesController.create);
router.patch('/categories/:id', validate({ params: z.object({ tenantId: objectId, id: objectId }), body: updateCategorySchema }), categoriesController.update);
router.delete('/categories/:id', validate({ params: z.object({ tenantId: objectId, id: objectId }) }), categoriesController.remove);

// -------------------------------------------------------------------- staff
router.get('/staff', validate({ query: listStaffSchema }), staffController.list);
router.post('/staff', validate({ body: createStaffSchema }), controller.auditedCreateStaff);
router.patch('/staff/:id', validate({ params: z.object({ tenantId: objectId, id: objectId }), body: updateStaffSchema }), controller.auditedUpdateStaff);
router.post('/staff/:id/reset-password', validate({ params: z.object({ tenantId: objectId, id: objectId }), body: resetStaffPasswordSchema }), staffController.resetPassword);
router.delete('/staff/:id', validate({ params: z.object({ tenantId: objectId, id: objectId }) }), staffController.remove);

// -------------------------------------------------------------------- roles
router.get('/roles', rolesController.list);
router.post('/roles', validate({ body: createRoleSchema }), controller.auditedCreateRole);
router.patch('/roles/:id', validate({ params: z.object({ tenantId: objectId, id: objectId }), body: updateRoleSchema }), controller.auditedUpdateRole);
router.delete('/roles/:id', validate({ params: z.object({ tenantId: objectId, id: objectId }) }), rolesController.remove);

// ---------------------------------------------------------------- inventory
router.get('/inventory', validate({ query: listStockSchema }), inventoryController.listStock);
router.get('/inventory/summary', inventoryController.summary);
router.post('/inventory/adjust', validate({ body: adjustStockSchema }), inventoryController.adjust);

// -------------------------------------------------------------------- sales
router.get('/sales', validate({ query: listSalesSchema }), salesController.list);
router.get('/sales/:id', validate({ params: z.object({ tenantId: objectId, id: objectId }) }), salesController.getOne);

export default router;
export { idParam };
