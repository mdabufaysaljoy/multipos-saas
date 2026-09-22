import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { isProd } from '../../config/env';
import { authenticate } from '../../middleware/auth';
import { resolveTenant } from '../../middleware/tenant';
import { validate, body } from '../../middleware/validate';
import { ok } from '../../utils/apiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import { qzSigning } from './qzSigning.service';

/**
 * QZ Tray support for direct thermal printing. Only signed-in members of a
 * workspace can obtain signatures; nothing here prints or accepts printer
 * commands - printing happens on the cashier's own computer through QZ Tray.
 */
const router = Router();
router.use(authenticate, resolveTenant);

// Every QZ call (connect, find printers, print) asks for one signature.
const signLimiter = rateLimit({
  windowMs: 60_000,
  limit: isProd ? 240 : 20_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many print requests. Wait a moment.' } },
});

router.get(
  '/qz/certificate',
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, { configured: qzSigning.isConfigured(), certificate: qzSigning.certificate() });
  }),
);

// QZ signs a short JSON/hash string; anything large is not a QZ request.
const signSchema = z.object({ request: z.string().min(1).max(10_000) }).strict();

router.post(
  '/qz/sign',
  signLimiter,
  validate({ body: signSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const signature = qzSigning.sign(body<{ request: string }>(req).request);
    ok(res, { configured: signature !== null, signature });
  }),
);

export default router;
