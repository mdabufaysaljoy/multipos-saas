import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import * as controller from './reports.controller';
import { reportRangeSchema } from './reports.validators';

const router = Router();
router.use(authenticate, resolveTenant);

router.get('/dashboard', requirePermission(PERMISSIONS.REPORTS_VIEW), validate({ query: reportRangeSchema }), controller.dashboard);

export default router;
