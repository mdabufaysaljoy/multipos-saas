import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { requireAccess } from '../../middleware/access';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { requireActiveSubscription, requireSubscribedAccess } from '../../middleware/subscription';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { requireVertical } from '../../middleware/vertical';
import { idParam } from '../common/common.validators';
import * as controller from './suppliers.controller';
import { createSupplierSchema, listSuppliersSchema, updateSupplierSchema } from './suppliers.validators';

/**
 * Supplier management (Clothing POS).
 *
 * Every route: signed in -> workspace + branch -> Clothing -> usable
 * subscription -> the `supplierManagement` entitlement (Professional and
 * Enterprise) -> the matching `suppliers.*` permission. A Starter workspace is
 * refused here, before any handler runs; hiding the menu item is not the gate.
 *
 * Suppliers are workspace-level, so no route takes a branch: the list a till
 * sees is the workspace's own, whichever branch it is signed into.
 */
const router = Router();
router.use(
  authenticate,
  resolveTenant,
  requireVertical('clothing'),
  requireSubscribedAccess,
  requireAccess({ entitlement: 'supplierManagement' }),
);

router.get('/summary', requirePermission(PERMISSIONS.SUPPLIERS_VIEW), controller.summary);
router.get('/', requirePermission(PERMISSIONS.SUPPLIERS_VIEW), validate({ query: listSuppliersSchema }), controller.list);
router.get('/:id', requirePermission(PERMISSIONS.SUPPLIERS_VIEW), validate({ params: idParam }), controller.getOne);

router.post(
  '/',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.SUPPLIERS_CREATE),
  validate({ body: createSupplierSchema }),
  controller.create,
);
router.patch(
  '/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.SUPPLIERS_EDIT),
  validate({ params: idParam, body: updateSupplierSchema }),
  controller.update,
);
router.post(
  '/:id/status',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.SUPPLIERS_EDIT),
  validate({ params: idParam, body: controller.statusSchema }),
  controller.setStatus,
);
router.delete(
  '/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.SUPPLIERS_DELETE),
  validate({ params: idParam }),
  controller.remove,
);

export default router;
