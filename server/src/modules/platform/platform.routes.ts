import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePlatformAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { idParam, objectId, paginationSchema } from '../common/common.validators';
import {
  assignSubscriptionSchema,
  extendSubscriptionSchema,
  setSubscriptionStatusSchema,
} from '../subscriptions/subscriptions.validators';
import * as controller from './platform.controller';

const router = Router();

// The entire platform surface is gated behind the platform-admin role, which is
// kept logically separate from tenant administration.
router.use(authenticate, requirePlatformAdmin);

const listQuery = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  status: z.string().trim().max(30).optional(),
  tenantId: objectId.optional(),
});

router.get('/overview', controller.overview);

router.get('/tenants', validate({ query: listQuery }), controller.listTenants);
router.get('/tenants/:id', validate({ params: idParam }), controller.getTenant);
router.patch(
  '/tenants/:id/status',
  validate({ params: idParam, body: z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().max(300).optional() }) }),
  controller.setTenantStatus,
);

router.get('/customers', validate({ query: listQuery }), controller.listCustomers);

router.get('/subscriptions', validate({ query: listQuery }), controller.listSubscriptions);
router.get('/subscriptions/expiring', controller.expiringSoon);
router.post('/subscriptions', validate({ body: assignSubscriptionSchema }), controller.assignSubscription);
router.post(
  '/subscriptions/:id/extend',
  validate({ params: idParam, body: extendSubscriptionSchema }),
  controller.extendSubscription,
);
router.patch(
  '/subscriptions/:id/status',
  validate({ params: idParam, body: setSubscriptionStatusSchema }),
  controller.setSubscriptionStatus,
);

router.get('/payments', validate({ query: listQuery }), controller.listPayments);
router.post(
  '/payments/:id/mark-paid',
  validate({
    params: idParam,
    body: z.object({ reference: z.string().trim().max(120).optional(), note: z.string().trim().max(300).optional() }),
  }),
  controller.markPaymentPaid,
);

export default router;
