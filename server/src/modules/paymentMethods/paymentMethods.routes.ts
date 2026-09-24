import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { requireActiveSubscription, requireSubscribedAccess } from '../../middleware/subscription';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './paymentMethods.controller';
import { createPaymentMethodSchema, updatePaymentMethodSchema } from './paymentMethods.validators';

/**
 * The tenders a workspace takes, in every POS vertical.
 *
 * Reading the list needs no special permission: every till has to know what it
 * may take, the same way it reads the branch's currency and tax. Changing the
 * list is a settings action, like changing the branch's enabled methods.
 */
const router = Router();
router.use(authenticate, resolveTenant, requireSubscribedAccess);

router.get('/', controller.list);
router.post('/', requireActiveSubscription, requirePermission(PERMISSIONS.SETTINGS_EDIT), validate({ body: createPaymentMethodSchema }), controller.create);
router.patch(
  '/:id',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.SETTINGS_EDIT),
  validate({ params: idParam, body: updatePaymentMethodSchema }),
  controller.update,
);
router.delete('/:id', requireActiveSubscription, requirePermission(PERMISSIONS.SETTINGS_EDIT), validate({ params: idParam }), controller.remove);

export default router;
