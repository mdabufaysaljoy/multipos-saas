import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isProd } from '../../config/env';
import { z } from 'zod';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
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

// The provider sends the customer's BROWSER here after its payment page. Public by
// nature (no session survives the round trip); it only ever asks the provider.
const callbackLimiter = rateLimit({
  windowMs: 60_000,
  limit: isProd ? 60 : 5_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
router.get('/callback/:provider', callbackLimiter, controller.callback);

router.get('/providers', authenticate, controller.providers);

// Every checkout opens a payment at the provider; keep a runaway client from opening hundreds.
const checkoutLimiter = rateLimit({
  windowMs: 60_000,
  limit: isProd ? 10 : 1_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many payment attempts. Wait a minute and try again.' } },
});

router.use(authenticate, resolveTenant);

router.get('/', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), validate({ query: paginationSchema }), controller.listMine);
router.post(
  '/checkout',
  checkoutLimiter,
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  validate({ body: checkoutSchema }),
  controller.checkout,
);
router.post(
  '/verify',
  requirePermission(PERMISSIONS.SUBSCRIPTION_MANAGE),
  // An ObjectId and nothing else: no operator objects, no extra fields.
  validate({ body: z.object({ paymentId: objectId }).strict() }),
  controller.verify,
);

export default router;
