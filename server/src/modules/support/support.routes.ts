import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './support.controller';
import { createTicketSchema, listTicketsSchema } from './support.validators';

/**
 * The STORE's side of support: signed in -> workspace -> the matching
 * `support.*` permission.
 *
 * Deliberately no `requireSubscribedAccess` and no `requireVertical`. A
 * workspace whose subscription has lapsed is precisely the one that needs to
 * reach the operator, and every POS type has problems to report; gating this
 * behind a plan would be a support desk that closes when the customer needs it.
 *
 * The platform operator's side lives under `/platform/support`, behind
 * `requirePlatformAdmin`, and is not reachable from here.
 */
const router = Router();

/**
 * Ticket creation is a stranger's free text landing in our database and in the
 * operator's inbox, so it is capped per account. Six an hour is far more than
 * anyone with a real problem writes, and little enough that a script cannot
 * bury the inbox. `closed` on a Redis outage: this is one of the few writes
 * where refusing costs the customer a retry and nothing else.
 */
const ticketLimiter = createRateLimiter({
  name: 'support-ticket',
  windowMs: 60 * 60_000,
  limit: 6,
  devLimit: 5_000,
  fallback: 'closed',
  keyGenerator: (req) => String(req.auth?.tenantId ?? req.ip),
  message: {
    success: false,
    error: { code: 'TOO_MANY_REQUESTS', message: 'You have opened several tickets recently. Please add to an existing one instead.' },
  },
});

router.use(authenticate, resolveTenant);

router.get('/', requirePermission(PERMISSIONS.SUPPORT_VIEW), validate({ query: listTicketsSchema }), controller.listMine);
router.get('/:id', requirePermission(PERMISSIONS.SUPPORT_VIEW), validate({ params: idParam }), controller.getMine);

router.post(
  '/',
  ticketLimiter,
  requirePermission(PERMISSIONS.SUPPORT_CREATE),
  validate({ body: createTicketSchema }),
  controller.create,
);

export default router;
