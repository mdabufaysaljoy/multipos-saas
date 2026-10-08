import { Router } from 'express';
import { createRateLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import * as controller from './paymentProviders.controller';
import { smsEventSchema } from './paymentProviders.validators';

const router = Router();

/**
 * Ingestion for self-hosted payment-SMS relays (the Paymently device role).
 *
 * This is the ONLY door such a device has, and it opens onto evidence alone:
 * there is no wallet-credit endpoint here, and nothing a device sends can name
 * an account or an amount to credit.
 *
 * Flooding is capped per IP: a relay forwards one message per real payment, so
 * a burst is either a retry storm or an attack.
 */
const eventLimiter = createRateLimiter({
  name: 'payment-provider-events',
  windowMs: 60_000,
  limit: 120,
  devLimit: 20_000,
  // A dropped relay event is a payment that silently never completes.
  fallback: 'memory',
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many events. Slow down.' } },
});

router.post('/paymently/events', eventLimiter, controller.authenticateDevice, validate({ body: smsEventSchema }), controller.receiveSmsEvent);

export default router;
