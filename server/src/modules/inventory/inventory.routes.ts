import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireVertical } from '../../middleware/vertical';
import { requireActiveSubscription, requireSubscribedAccess } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import * as controller from './inventory.controller';
import { adjustStockSchema, ledgerSchema, listStockSchema } from './inventory.validators';
import { posLedgerQuerySchema } from '../../services/inventory/posLedger';
import { stockLedger } from '../inventory/stockLedger.controller';

const router = Router();
// An unsubscribed workspace can reach only its wallet and subscription;
// this module is locked entirely until a plan is active.
// Clothing POS module: other verticals are refused before anything else runs.
router.use(authenticate, resolveTenant, requireVertical('clothing'), requireSubscribedAccess);

router.get('/', requirePermission(PERMISSIONS.INVENTORY_VIEW), validate({ query: listStockSchema }), controller.listStock);
router.get('/summary', requirePermission(PERMISSIONS.INVENTORY_VIEW), controller.summary);
router.get('/ledger', requirePermission(PERMISSIONS.INVENTORY_VIEW), validate({ query: ledgerSchema }), controller.ledger);
// The same ledger in the shape every vertical reports; see services/inventory/posLedger.
router.get('/stock-ledger', requirePermission(PERMISSIONS.INVENTORY_VIEW), validate({ query: posLedgerQuerySchema }), stockLedger);

router.post(
  '/adjust',
  requireActiveSubscription,
  requirePermission(PERMISSIONS.INVENTORY_ADJUST),
  validate({ body: adjustStockSchema }),
  controller.adjust,
);

export default router;
