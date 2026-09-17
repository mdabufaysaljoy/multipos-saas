import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireVertical } from '../../middleware/vertical';
import { requireActiveSubscription, requireSubscribedAccess } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './sales.controller';
import { cancelSaleSchema, createSaleSchema, listSalesSchema } from './sales.validators';

const router = Router();
// An unsubscribed workspace can reach only its wallet and subscription;
// this module is locked entirely until a plan is active.
// Clothing POS module: other verticals are refused before anything else runs.
router.use(authenticate, resolveTenant, requireVertical('clothing'), requireSubscribedAccess);

router.post(
  '/',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.SALES_CREATE),
  validate({ body: createSaleSchema }),
  controller.create,
);

router.get('/', requirePermission(PERMISSIONS.SALES_VIEW), validate({ query: listSalesSchema }), controller.list);

// Static segment first so "by-number" is never treated as an id.
router.get(
  '/by-number/:saleNumber',
  requirePermission(PERMISSIONS.SALES_VIEW),
  validate({ params: z.object({ saleNumber: z.string().trim().min(1).max(40) }) }),
  controller.getByNumber,
);

router.get('/:id', requirePermission(PERMISSIONS.SALES_VIEW), validate({ params: idParam }), controller.getOne);
router.get('/:id/receipt', requirePermission(PERMISSIONS.SALES_VIEW), validate({ params: idParam }), controller.receipt);

router.post(
  '/:id/cancel',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.SALES_CANCEL),
  validate({ params: idParam, body: cancelSaleSchema }),
  controller.cancel,
);

export default router;
