import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireVertical } from '../../middleware/vertical';
import { requireActiveSubscription, requireSubscribedAccess } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import { idParam, objectId } from '../common/common.validators';
import * as controller from './returns.controller';
import { createReturnSchema, listReturnsSchema } from './returns.validators';

const router = Router();
// An unsubscribed workspace can reach only its wallet and subscription;
// this module is locked entirely until a plan is active.
// Clothing POS module: other verticals are refused before anything else runs.
router.use(authenticate, resolveTenant, requireVertical('clothing'), requireSubscribedAccess);

router.get('/', requirePermission(PERMISSIONS.RETURNS_VIEW), validate({ query: listReturnsSchema }), controller.list);

router.get(
  '/returnable/:saleId',
  requirePermission(PERMISSIONS.RETURNS_VIEW),
  validate({ params: z.object({ saleId: objectId }) }),
  controller.returnableSale,
);

router.get('/:id', requirePermission(PERMISSIONS.RETURNS_VIEW), validate({ params: idParam }), controller.getOne);

router.post(
  '/',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.RETURNS_CREATE),
  validate({ body: createReturnSchema }),
  controller.create,
);

export default router;
