import express, { Router } from 'express';
import { createRateLimiter } from '../../middleware/rateLimit';
import { z } from 'zod';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { requireVerifiedContact } from '../../middleware/verifiedContact';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { objectId, paginationSchema } from '../common/common.validators';
import { checkoutSchema } from '../subscriptions/subscriptions.validators';
import * as controller from './payments.controller';

const router = Router();

// Webhooks are unauthenticated by nature; their trust comes from the signature
// check inside each provider adapter, never from a session.
// bKash notifications arrive through Amazon SNS as text/plain JSON; keep the exact text.
router.post('/webhook/:provider', express.text({ type: 'text/plain', limit: '256kb' }), controller.webhook);
// Some gateways deliver the same notification as a GET with a query string
// instead of a body - ZiniPay documents its payload as "JSON Body / Query". A
// notification that arrives on a method we refuse is a payment that silently
// never completes, and the handler already reads the query either way.
// Accepting it is safe because a notification is never believed: whatever it
// says, the payment is confirmed by asking the gateway.
router.get('/webhook/:provider', controller.webhook);

// The provider sends the customer's BROWSER here after its payment page. Public by
// nature (no session survives the round trip); it only ever asks the provider.
const callbackLimiter = createRateLimiter({
  name: 'payment-callback',
  windowMs: 60_000,
  limit: 60,
  devLimit: 5_000,
  // The customer's browser returns here after paying. Refusing it would leave
  // a paid order unconfirmed, which is far worse than a loose limit.
  fallback: 'memory',
});
router.get('/callback/:provider', callbackLimiter, controller.callback);

router.get('/providers', authenticate, controller.providers);

// Every checkout opens a payment at the provider; keep a runaway client from opening hundreds.
const checkoutLimiter = createRateLimiter({
  name: 'payment-checkout',
  windowMs: 60_000,
  limit: 10,
  devLimit: 1_000,
  // Refusing a checkout is lost revenue, and each one is already guarded by an
  // idempotency key and a CAS lock on the workspace.
  fallback: 'memory',
});

router.use(authenticate, resolveTenant);

router.get('/', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), validate({ query: paginationSchema }), controller.listMine);
router.post(
  '/checkout',
  checkoutLimiter,
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  // A payment is about to be started with a provider: prove a contact first.
  requireVerifiedContact,
  validate({ body: checkoutSchema }),
  controller.checkout,
);
// Confirming a payment the customer has just returned from. Which permission
// is needed depends on what the payment was for, so it is checked in the
// controller rather than declared here.
router.post('/confirm', validate({ body: z.object({ paymentId: objectId }).strict() }), controller.confirm);
router.post(
  '/verify',
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  // An ObjectId and nothing else: no operator objects, no extra fields.
  validate({ body: z.object({ paymentId: objectId }).strict() }),
  controller.verify,
);

export default router;
