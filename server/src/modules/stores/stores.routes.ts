import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate, requireTenantAdmin } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './stores.controller';
import { createStoreSchema, updateStoreSchema } from './stores.validators';

const router = Router();

// Listing and creation deliberately skip `resolveTenant`: during onboarding the
// tenant has no store yet, and resolveTenant requires one to exist.
router.get('/', authenticate, controller.list);
router.post('/', authenticate, requireTenantAdmin, validate({ body: createStoreSchema }), controller.create);

// No permission gate: every cashier needs currency, tenders and tax to sell.
router.get('/pos-config', authenticate, resolveTenant, controller.posConfig);

router.get('/current', authenticate, resolveTenant, requirePermission(PERMISSIONS.SETTINGS_VIEW), controller.getCurrent);
router.patch(
  '/current',
  authenticate,
  resolveTenant,
  requirePermission(PERMISSIONS.SETTINGS_EDIT),
  validate({ body: updateStoreSchema }),
  controller.updateCurrent,
);
router.patch(
  '/:id',
  authenticate,
  resolveTenant,
  requirePermission(PERMISSIONS.SETTINGS_EDIT),
  validate({ params: idParam, body: updateStoreSchema }),
  controller.update,
);

export default router;
