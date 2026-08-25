import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { paginationSchema } from '../common/common.validators';
import { checkoutSchema } from '../subscriptions/subscriptions.validators';
import * as controller from './payments.controller';

const router = Router();

// Webhooks are unauthenticated by nature; their trust comes from the signature
// check inside each provider adapter, never from a session.
router.post('/webhook/:provider', controller.webhook);

router.get('/providers', authenticate, controller.providers);

router.use(authenticate, resolveTenant);

router.get('/', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), validate({ query: paginationSchema }), controller.listMine);
router.post(
  '/checkout',
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  validate({ body: checkoutSchema }),
  controller.checkout,
);
router.post(
  '/verify',
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  validate({ body: z.object({ paymentId: z.string().min(1) }) }),
  controller.verify,
);

export default router;
