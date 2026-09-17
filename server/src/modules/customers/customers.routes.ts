import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireActiveSubscription, requireSubscribedAccess } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './customers.controller';
import { createCustomerSchema, listCustomersSchema, updateCustomerSchema } from './customers.validators';

const router = Router();
// An unsubscribed workspace can reach only its wallet and subscription;
// this module is locked entirely until a plan is active.
router.use(authenticate, resolveTenant, requireSubscribedAccess);

router.get('/', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ query: listCustomersSchema }), controller.list);
router.get('/:id', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ params: idParam }), controller.getOne);

router.post(
  '/',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CUSTOMERS_CREATE),
  validate({ body: createCustomerSchema }),
  controller.create,
);
router.patch(
  '/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CUSTOMERS_EDIT),
  validate({ params: idParam, body: updateCustomerSchema }),
  controller.update,
);
router.delete(
  '/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.CUSTOMERS_DELETE),
  validate({ params: idParam }),
  controller.remove,
);

export default router;
