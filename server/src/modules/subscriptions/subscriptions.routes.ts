import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import * as controller from './subscriptions.controller';
import { cancelSubscriptionSchema } from './subscriptions.validators';

const router = Router();
router.use(authenticate, resolveTenant);

// Deliberately NOT behind requireActiveSubscription: an expired tenant must
// still be able to see and fix their subscription.
router.get('/current', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), controller.current);
router.get('/history', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), controller.history);

router.post(
  '/cancel',
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  validate({ body: cancelSubscriptionSchema }),
  controller.cancel,
);
router.post('/reactivate', requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE), controller.reactivate);

export default router;
