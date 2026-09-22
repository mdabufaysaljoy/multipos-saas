import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { requireAccess, requireEntitlement } from '../../middleware/access';
import { authenticate } from '../../middleware/auth';
import { requireActiveSubscription, requireSubscribedAccess } from '../../middleware/subscription';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './loyalty.controller';
import {
  adjustPointsSchema,
  customerParam,
  historySchema,
  issueMembershipSchema,
  listMembershipsSchema,
  lookupSchema,
  setStatusSchema,
} from './loyalty.validators';

/**
 * Loyalty program (Clothing POS). Every route requires, on the server:
 *   signed in -> workspace + branch -> usable subscription -> the `loyalty`
 *   entitlement (Professional / Enterprise, Clothing only) -> a permission.
 * The service re-checks the entitlement, so nothing depends on route order.
 */
const router = Router();
router.use(authenticate, resolveTenant, requireSubscribedAccess, requireEntitlement('loyalty'));

// The till: scanning a card is part of selling.
router.get('/lookup', requireAccess({ permission: PERMISSIONS.SALES_CREATE }), validate({ query: lookupSchema }), controller.lookup);

router.get('/summary', requireAccess({ permission: PERMISSIONS.LOYALTY_VIEW }), controller.summary);
router.get('/memberships', requireAccess({ permission: PERMISSIONS.LOYALTY_VIEW }), validate({ query: listMembershipsSchema }), controller.list);
router.get('/memberships/:id', requireAccess({ permission: PERMISSIONS.LOYALTY_VIEW }), validate({ params: idParam }), controller.getOne);
router.get('/memberships/:id/history', requireAccess({ permission: PERMISSIONS.LOYALTY_VIEW }), validate({ params: idParam, query: historySchema }), controller.history);
router.get('/customers/:customerId', requireAccess({ permission: [PERMISSIONS.CUSTOMERS_VIEW] }), validate({ params: customerParam }), controller.forCustomer);

router.post('/memberships', requireActiveSubscription, requireAccess({ permission: PERMISSIONS.LOYALTY_MANAGE }), validate({ body: issueMembershipSchema }), controller.issue);
router.post(
  '/memberships/:id/status',
  requireActiveSubscription,
  requireAccess({ permission: PERMISSIONS.LOYALTY_MANAGE }),
  validate({ params: idParam, body: setStatusSchema }),
  controller.setStatus,
);
router.post(
  '/memberships/:id/adjust',
  requireActiveSubscription,
  requireAccess({ permission: PERMISSIONS.LOYALTY_MANAGE }),
  validate({ params: idParam, body: adjustPointsSchema }),
  controller.adjust,
);

export default router;
