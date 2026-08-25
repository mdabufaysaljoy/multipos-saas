import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requireAnyPermission, requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireActiveSubscription } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import { idParam, objectId } from '../common/common.validators';
import * as controller from './products.controller';
import {
  createProductSchema,
  createVariantSchema,
  listProductsSchema,
  posSearchSchema,
  updateProductSchema,
  updateVariantSchema,
} from './products.validators';

const router = Router();
router.use(authenticate, resolveTenant);

const variantParams = z.object({ id: objectId, variantId: objectId });

// POS lookup sits before "/:id" so "pos-search" is not parsed as an id.
router.get('/pos-search', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ query: posSearchSchema }), controller.posSearch);

// Static segments before "/:id" so they are not parsed as ids.
router.post(
  '/barcode/generate',
  requireActiveSubscription,
  requireAnyPermission(PERMISSIONS.PRODUCTS_CREATE, PERMISSIONS.PRODUCTS_EDIT),
  controller.generateBarcode,
);

router.get('/', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ query: listProductsSchema }), controller.list);
router.get('/:id', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: idParam }), controller.getOne);

router.post(
  '/',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.PRODUCTS_CREATE),
  validate({ body: createProductSchema }),
  controller.create,
);
router.patch(
  '/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.PRODUCTS_EDIT),
  validate({ params: idParam, body: updateProductSchema }),
  controller.update,
);
router.delete(
  '/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.PRODUCTS_DELETE),
  validate({ params: idParam }),
  controller.remove,
);

router.post(
  '/:id/variants',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.PRODUCTS_CREATE),
  validate({ params: idParam, body: createVariantSchema }),
  controller.addVariant,
);
router.patch(
  '/:id/variants/:variantId',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.PRODUCTS_EDIT),
  validate({ params: variantParams, body: updateVariantSchema }),
  controller.updateVariant,
);
router.delete(
  '/:id/variants/:variantId',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.PRODUCTS_DELETE),
  validate({ params: variantParams }),
  controller.removeVariant,
);

export default router;
