import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import * as controller from './auth.controller';
import { changePasswordSchema, loginSchema, registerSchema } from './auth.validators';

const router = Router();

/** Credential endpoints are rate limited to blunt brute-force attempts. */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try again in a few minutes.' } },
});

router.post('/register', credentialLimiter, validate({ body: registerSchema }), controller.register);
router.post('/login', credentialLimiter, validate({ body: loginSchema }), controller.login);
router.post('/refresh', controller.refresh);
router.post('/logout', controller.logout);

router.get('/me', authenticate, controller.me);
router.post('/change-password', authenticate, validate({ body: changePasswordSchema }), controller.changePassword);

export default router;
