import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireVertical } from '../../middleware/vertical';
import { requireActiveSubscription, requireSubscribedAccess } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './categories.controller';
import { createCategorySchema, listCategoriesSchema, updateCategorySchema } from './categories.validators';

const router = Router();
// An unsubscribed workspace can reach only its wallet and subscription;
// this module is locked entirely until a plan is active.
// Clothing POS module: other verticals are refused before anything else runs.
router.use(authenticate, resolveTenant, requireVertical('clothing'), requireSubscribedAccess);

router.get('/', requirePermission(PERMISSIONS.CATEGORIES_VIEW), validate({ query: listCategoriesSchema }), controller.list);
router.get('/:id', requirePermission(PERMISSIONS.CATEGORIES_VIEW), validate({ params: idParam }), controller.getOne);

// Every write additionally requires a live subscription.
router.post(
  '/',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CATEGORIES_CREATE),
  validate({ body: createCategorySchema }),
  controller.create,
);
router.patch(
  '/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CATEGORIES_EDIT),
  validate({ params: idParam, body: updateCategorySchema }),
  controller.update,
);
router.delete(
  '/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CATEGORIES_DELETE),
  validate({ params: idParam }),
  controller.remove,
);

export default router;
