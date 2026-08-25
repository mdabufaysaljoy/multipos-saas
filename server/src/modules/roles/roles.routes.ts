import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireActiveSubscription } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './roles.controller';
import { createRoleSchema, updateRoleSchema } from './roles.validators';

const router = Router();
router.use(authenticate, resolveTenant);

// Any authenticated user may read the catalogue; it contains no tenant data.
router.get('/permissions/catalog', controller.catalog);

router.get('/', requirePermission(PERMISSIONS.ROLES_VIEW), controller.list);
router.post(
  '/',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  validate({ body: createRoleSchema }),
  controller.create,
);
router.patch(
  '/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  validate({ params: idParam, body: updateRoleSchema }),
  controller.update,
);
router.delete(
  '/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  validate({ params: idParam }),
  controller.remove,
);

export default router;
