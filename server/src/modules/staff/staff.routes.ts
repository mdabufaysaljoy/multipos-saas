import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireActiveSubscription } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './staff.controller';
import {
  createStaffSchema,
  listStaffSchema,
  resetStaffPasswordSchema,
  updateStaffSchema,
} from './staff.validators';

const router = Router();
router.use(authenticate, resolveTenant);

router.get('/', requirePermission(PERMISSIONS.STAFF_VIEW), validate({ query: listStaffSchema }), controller.list);
router.get('/:id', requirePermission(PERMISSIONS.STAFF_VIEW), validate({ params: idParam }), controller.getOne);

router.post(
  '/',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.STAFF_CREATE),
  validate({ body: createStaffSchema }),
  controller.create,
);
router.patch(
  '/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.STAFF_EDIT),
  validate({ params: idParam, body: updateStaffSchema }),
  controller.update,
);
router.post(
  '/:id/reset-password',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.STAFF_EDIT),
  validate({ params: idParam, body: resetStaffPasswordSchema }),
  controller.resetPassword,
);
router.delete(
  '/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.STAFF_DELETE),
  validate({ params: idParam }),
  controller.remove,
);

export default router;
