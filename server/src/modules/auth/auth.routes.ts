import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isProd } from '../../config/env';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './auth.controller';
import { changePasswordSchema, loginSchema, registerSchema, selectLoginSchema, switchWorkspaceSchema } from './auth.validators';

const router = Router();

/**
 * Credential endpoints are rate limited to blunt brute-force attempts.
 * The limit is relaxed in development so the end-to-end suite - which signs in
 * as several accounts on every run - is not throttled. Production keeps the
 * strict window.
 */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Production stays strict. Development needs headroom because the
  // end-to-end suite registers and signs in as dozens of accounts per run,
  // and a throttled test run looks like a product failure.
  limit: isProd ? 20 : 5_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try again in a few minutes.' } },
});

router.post('/register', credentialLimiter, validate({ body: registerSchema }), controller.register);
router.post('/login', credentialLimiter, validate({ body: loginSchema }), controller.login);
router.post('/login/select', credentialLimiter, validate({ body: selectLoginSchema }), controller.selectLogin);
router.post('/refresh', controller.refresh);
router.post('/logout', controller.logout);

router.get('/me', authenticate, controller.me);

/**
 * Switching mints a new token pair, so it is throttled like other token
 * issuance - loosely enough for a person hopping between their shops.
 */
const switchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: isProd ? 30 : 2_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many workspace switches. Try again in a minute.' } },
});

router.get('/workspaces', authenticate, controller.workspaces);
router.post('/switch-workspace', switchLimiter, authenticate, validate({ body: switchWorkspaceSchema }), controller.switchWorkspace);
router.post('/change-password', authenticate, validate({ body: changePasswordSchema }), controller.changePassword);

export default router;
