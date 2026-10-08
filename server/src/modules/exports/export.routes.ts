import { Router } from 'express';
import { createRateLimiter } from '../../middleware/rateLimit';
import { PERMISSIONS } from '../../config/permissions';
import { requireAccess } from '../../middleware/access';
import { authenticate } from '../../middleware/auth';
import { requireSubscribedAccess } from '../../middleware/subscription';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import * as controller from './export.controller';
import { EXPORTS_PER_MINUTE } from './export.limits';
import { createExportSchema, listExportsSchema } from './export.validators';

/**
 * Data export for every shipped POS type.
 *
 * Every route: signed in -> workspace + branch -> usable subscription ->
 * `dataExport` entitlement (Professional / Enterprise) -> `reports.export`
 * permission. The entitlement is resolved from the database per request, so a
 * downgraded workspace loses access immediately.
 */
const router = Router();
router.use(
  authenticate,
  resolveTenant,
  requireSubscribedAccess,
  requireAccess({ entitlement: 'dataExport', permission: PERMISSIONS.REPORTS_EXPORT }),
);

router.get('/datasets', controller.datasets);
router.get('/', validate({ query: listExportsSchema }), controller.history);

// Generating a file is expensive; a handful per minute is plenty for a person.
const exportLimiter = createRateLimiter({
  name: 'export',
  windowMs: 60_000,
  limit: EXPORTS_PER_MINUTE,
  devLimit: 10_000,
  // An export still streams up to 200,000 rows inside the request, so this
  // limiter protects the API's own capacity. Refusing one for a minute costs
  // the user a retry; letting every replica allow five costs everyone else.
  fallback: 'closed',
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many exports. Wait a minute and try again.' } },
});

router.post('/', exportLimiter, validate({ body: createExportSchema }), controller.create);

export default router;
