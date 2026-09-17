import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isProd } from '../../config/env';
import { authenticate } from '../../middleware/auth';
import { requireWorkspaceAccess, resolveAccount } from '../../middleware/account';
import { validate } from '../../middleware/validate';
import * as controller from './workspaces.controller';
import { cancelWorkspaceSubscriptionSchema, createWorkspaceSchema, emptyBodySchema, updateWorkspaceSchema, workspaceParams } from './workspaces.validators';
import { autoRenewSchema, purchaseQuoteSchema, workspaceCheckoutSchema, scheduleChangeSchema } from '../subscriptions/purchase.validators';

const router = Router();

/**
 * Account-level, so deliberately NOT behind `resolveTenant` or a subscription
 * gate: an owner may open a new workspace from any workspace they are in, even
 * one whose own plan has lapsed. Ownership is checked in the service.
 */
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: isProd ? 10 : 1_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many workspaces created. Try again later.' } },
});

router.get('/verticals', authenticate, controller.verticals);
// The same active catalog, for the registration page. Names and descriptions only.
router.get('/verticals/public', controller.verticals);
router.post('/', createLimiter, authenticate, validate({ body: createWorkspaceSchema }), controller.create);

// Owner-only workspace management. The account comes from the signed-in user;
// the workspace id is only accepted after `canAccessWorkspace` confirms that
// account owns it. Another account's id and a missing id both answer 404.
router.get('/', authenticate, resolveAccount, controller.list);
router.get('/:workspaceId', authenticate, resolveAccount, validate({ params: workspaceParams }), requireWorkspaceAccess(), controller.get);
router.patch(
  '/:workspaceId',
  authenticate,
  resolveAccount,
  validate({ params: workspaceParams, body: updateWorkspaceSchema }),
  requireWorkspaceAccess(),
  controller.update,
);

// Each workspace's own subscription. Only reachable for a workspace the
// signed-in account owns; cancelling one never touches another.
const cancelLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProd ? 20 : 1_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Try again later.' } },
});
router.get('/:workspaceId/subscription', authenticate, resolveAccount, validate({ params: workspaceParams }), requireWorkspaceAccess(), controller.subscription);
// Any owned workspace's entitlements. Another account's workspace is a 404.
router.get('/:workspaceId/entitlements', authenticate, resolveAccount, validate({ params: workspaceParams }), requireWorkspaceAccess(), controller.entitlements);
// Choosing and buying a plan for any owned workspace, without switching into it. Priced by the server every time.
router.get('/:workspaceId/plans', authenticate, resolveAccount, validate({ params: workspaceParams }), requireWorkspaceAccess(), controller.planOptions);
router.post(
  '/:workspaceId/checkout/quote',
  cancelLimiter,
  authenticate,
  resolveAccount,
  validate({ params: workspaceParams, body: purchaseQuoteSchema }),
  requireWorkspaceAccess(),
  controller.checkoutQuote,
);
router.post(
  '/:workspaceId/checkout',
  cancelLimiter,
  authenticate,
  resolveAccount,
  validate({ params: workspaceParams, body: workspaceCheckoutSchema }),
  requireWorkspaceAccess(),
  controller.checkout,
);
router.post(
  '/:workspaceId/subscription/cancel',
  cancelLimiter,
  authenticate,
  resolveAccount,
  validate({ params: workspaceParams, body: cancelWorkspaceSubscriptionSchema }),
  requireWorkspaceAccess(),
  controller.cancelSubscription,
);
// Renewal controls for any owned workspace, from the account billing page.
router.post(
  '/:workspaceId/subscription/auto-renew',
  cancelLimiter,
  authenticate,
  resolveAccount,
  validate({ params: workspaceParams, body: autoRenewSchema }),
  requireWorkspaceAccess(),
  controller.setAutoRenew,
);
// Upgrades and cycle changes are bought now through checkout; any plan can instead be scheduled for the next renewal.
router.post(
  '/:workspaceId/subscription/scheduled-change',
  cancelLimiter,
  authenticate,
  resolveAccount,
  validate({ params: workspaceParams, body: scheduleChangeSchema }),
  requireWorkspaceAccess(),
  controller.scheduleChange,
);
router.delete(
  '/:workspaceId/subscription/scheduled-change',
  cancelLimiter,
  authenticate,
  resolveAccount,
  validate({ params: workspaceParams }),
  requireWorkspaceAccess(),
  controller.cancelScheduledChange,
);
router.post(
  '/:workspaceId/subscription/renew',
  cancelLimiter,
  authenticate,
  resolveAccount,
  validate({ params: workspaceParams, body: emptyBodySchema }),
  requireWorkspaceAccess(),
  controller.renewSubscription,
);
router.post(
  '/:workspaceId/subscription/reactivate',
  cancelLimiter,
  authenticate,
  resolveAccount,
  validate({ params: workspaceParams, body: emptyBodySchema }),
  requireWorkspaceAccess(),
  controller.reactivateSubscription,
);

export default router;
