import { emptyBodySchema } from '../workspaces/workspaces.validators';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isProd } from '../../config/env';
import { autoRenewSchema, purchaseQuoteSchema, purchaseSchema, scheduleChangeSchema } from './purchase.validators';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import * as controller from './subscriptions.controller';
import { idParam } from '../common/common.validators';
import { cancelSubscriptionSchema, couponQuoteSchema, submitUpgradeSchema } from './subscriptions.validators';
import { invoiceParams, workspaceInvoiceQuerySchema } from './invoices.validators';

const router = Router();
router.use(authenticate, resolveTenant);

// Deliberately NOT behind requireActiveSubscription: an expired tenant must
// still be able to see and fix their subscription.
router.get('/current', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), controller.current);
router.get('/history', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), controller.history);
// What this workspace's subscription grants, with usage. Plan contents only - no money - so any member may read it.
router.get('/entitlements', controller.entitlements);

router.post(
  '/cancel',
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  validate({ body: cancelSubscriptionSchema }),
  controller.cancel,
);
router.post('/reactivate', requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE), controller.reactivate);

// Upgrades are NOT behind requireActiveSubscription: an expired tenant must be
// able to pay their way back in.
router.post(
  '/coupon-quote',
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  validate({ body: couponQuoteSchema }),
  controller.quoteCoupon,
);

router.get('/plan-options', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), controller.planOptions);

// Buying a plan in catalog terms. The server prices it; the body cannot carry an amount.
const purchaseLimiter = rateLimit({
  windowMs: 60_000,
  limit: isProd ? 20 : 10_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many purchase attempts. Wait a minute and try again.' } },
});
router.post(
  '/purchase/quote',
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  validate({ body: purchaseQuoteSchema }),
  controller.purchaseQuote,
);
router.post(
  '/purchase',
  purchaseLimiter,
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  validate({ body: purchaseSchema }),
  controller.purchase,
);

// Renewal: automatic renewal from the wallet, and a plan change for the next renewal.
router.get('/renewal', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), controller.renewalInfo);
// Automatic renewal spends the account wallet, so it needs the wallet permission too.
router.post('/auto-renew', requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE, PERMISSIONS.WALLET_MANAGE), validate({ body: autoRenewSchema }), controller.setAutoRenew);
// Renew now from the account wallet. No amount in the body: the server prices it.
router.post('/renew', purchaseLimiter, requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE, PERMISSIONS.WALLET_MANAGE), validate({ body: emptyBodySchema }), controller.renew);
router.post(
  '/scheduled-change',
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  validate({ body: scheduleChangeSchema }),
  controller.scheduleChange,
);
router.delete('/scheduled-change', requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE), controller.cancelScheduledChange);

// This workspace's own invoices.
router.get('/invoices', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), validate({ query: workspaceInvoiceQuerySchema }), controller.invoices);
router.get('/invoices/:invoiceId', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), validate({ params: invoiceParams }), controller.invoice);

router.get('/payment-instructions', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), controller.paymentInstructions);

router.post(
  '/upgrade-request',
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  validate({ body: submitUpgradeSchema }),
  controller.submitUpgrade,
);
router.get('/upgrade-requests', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), controller.listUpgradeRequests);
router.post(
  '/upgrade-requests/:id/cancel',
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  validate({ params: idParam }),
  controller.cancelUpgradeRequest,
);

export default router;
