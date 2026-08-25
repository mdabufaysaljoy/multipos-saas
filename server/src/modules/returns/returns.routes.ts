import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireActiveSubscription } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import { idParam, objectId } from '../common/common.validators';
import * as controller from './returns.controller';
import { createReturnSchema, listReturnsSchema } from './returns.validators';

const router = Router();
router.use(authenticate, resolveTenant);

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
