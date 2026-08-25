import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireActiveSubscription } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './categories.controller';
import { createCategorySchema, listCategoriesSchema, updateCategorySchema } from './categories.validators';

const router = Router();
router.use(authenticate, resolveTenant);

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
