import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { requireActiveSubscription, requireSubscribedAccess } from '../../middleware/subscription';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { requireVertical } from '../../middleware/vertical';
import { idParam } from '../common/common.validators';
import * as controller from './posShifts.controller';
import {
  closePosShiftSchema,
  listPosShiftsSchema,
  openPosShiftSchema,
  posCashMovementSchema,
} from './posShifts.validators';

const router = Router();

// Tenant and vertical are resolved from the authenticated workspace, never a
// request parameter. Every service query repeats tenant + branch + vertical.
router.use(authenticate, resolveTenant, requireVertical('clothing', 'supershop'), requireSubscribedAccess);

router.get('/current', requirePermission(PERMISSIONS.SALES_CREATE), controller.current);
router.post(
  '/',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.SALES_CREATE),
  validate({ body: openPosShiftSchema }),
  controller.open,
);
router.post(
  '/:id/cash-movements',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.SALES_CREATE),
  validate({ params: idParam, body: posCashMovementSchema }),
  controller.addCashMovement,
);
router.post(
  '/:id/close',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.SALES_CREATE),
  validate({ params: idParam, body: closePosShiftSchema }),
  controller.close,
);
router.get('/', requirePermission(PERMISSIONS.REPORTS_VIEW), validate({ query: listPosShiftsSchema }), controller.list);
router.get('/:id', requirePermission(PERMISSIONS.REPORTS_VIEW), validate({ params: idParam }), controller.get);

export default router;
