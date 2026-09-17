import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isProd } from '../../config/env';
import { authenticate } from '../../middleware/auth';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import * as controller from './pricing.controller';
import { catalogQuerySchema, quoteSchema, workspaceQuoteSchema } from './pricing.validators';

const router = Router();

const quoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: isProd ? 60 : 10_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many price requests. Try again shortly.' } },
});

// Prices are public: a prospective customer must be able to see them.
// Changing them is platform-admin only (see /platform/pricing).
router.get('/', validate({ query: catalogQuerySchema }), controller.catalog);
router.post('/quote', quoteLimiter, validate({ body: quoteSchema }), controller.quote);
router.post('/workspace-quote', quoteLimiter, authenticate, resolveTenant, validate({ body: workspaceQuoteSchema }), controller.workspaceQuote);

export default router;
