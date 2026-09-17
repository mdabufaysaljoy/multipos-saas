import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate, requireTenantAdmin } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { requireSubscribedAccess } from '../../middleware/subscription';
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
router.get('/pos-config', authenticate, resolveTenant, requireSubscribedAccess, controller.posConfig);

router.get('/current', authenticate, resolveTenant, requireSubscribedAccess, requirePermission(PERMISSIONS.SETTINGS_VIEW), controller.getCurrent);
router.patch(
  '/current',
  authenticate,
  resolveTenant,
  requireSubscribedAccess,
  requirePermission(PERMISSIONS.SETTINGS_EDIT),
  validate({ body: updateStoreSchema }),
  controller.updateCurrent,
);
router.patch(
  '/:id',
  authenticate,
  resolveTenant,
  requireSubscribedAccess,
  requirePermission(PERMISSIONS.SETTINGS_EDIT),
  validate({ params: idParam, body: updateStoreSchema }),
  controller.update,
);

// Deleting a branch is a settings-level action for the store owner.
router.post(
  '/:id/make-default',
  authenticate,
  resolveTenant,
  requireSubscribedAccess,
  requirePermission(PERMISSIONS.SETTINGS_EDIT),
  validate({ params: idParam }),
  controller.makeDefault,
);
router.delete(
  '/:id',
  authenticate,
  resolveTenant,
  requireSubscribedAccess,
  requirePermission(PERMISSIONS.SETTINGS_EDIT),
  validate({ params: idParam }),
  controller.remove,
);

export default router;
