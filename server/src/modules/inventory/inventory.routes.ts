import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireActiveSubscription } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import * as controller from './inventory.controller';
import { adjustStockSchema, ledgerSchema, listStockSchema } from './inventory.validators';

const router = Router();
router.use(authenticate, resolveTenant);

router.get('/', requirePermission(PERMISSIONS.INVENTORY_VIEW), validate({ query: listStockSchema }), controller.listStock);
router.get('/summary', requirePermission(PERMISSIONS.INVENTORY_VIEW), controller.summary);
router.get('/ledger', requirePermission(PERMISSIONS.INVENTORY_VIEW), validate({ query: ledgerSchema }), controller.ledger);

router.post(
  '/adjust',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.INVENTORY_ADJUST),
  validate({ body: adjustStockSchema }),
  controller.adjust,
);

export default router;
