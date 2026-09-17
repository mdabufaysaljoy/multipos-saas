import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireActiveSubscription, requireFeature, requireSubscribedAccess } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './roles.controller';
import { createRoleSchema, updateRoleSchema } from './roles.validators';

const router = Router();
// An unsubscribed workspace can reach only its wallet and subscription;
// this module is locked entirely until a plan is active.
router.use(authenticate, resolveTenant, requireSubscribedAccess);

// Creating a role of your own is a paid-tier feature. Reading and assigning the
// built-in system roles stays open on every plan, so a Starter workspace can
// still run a till with a cashier - it simply cannot invent new roles.
const customRoles = requireFeature('customRoles', 'Custom roles');

// Any authenticated user may read the catalogue; it contains no tenant data.
router.get('/permissions/catalog', controller.catalog);

router.get('/', requirePermission(PERMISSIONS.ROLES_VIEW), controller.list);
router.post(
  '/',
  requireActiveSubscription,
  customRoles,
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  validate({ body: createRoleSchema }),
  controller.create,
);
router.patch(
  '/:id',
  requireActiveSubscription,
  customRoles,
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  validate({ params: idParam, body: updateRoleSchema }),
  controller.update,
);
router.delete(
  '/:id',
  requireActiveSubscription,
  customRoles,
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  validate({ params: idParam }),
  controller.remove,
);

export default router;
