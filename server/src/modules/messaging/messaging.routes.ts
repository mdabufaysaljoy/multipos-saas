import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isProd } from '../../config/env';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireActiveSubscription, requireFeature, requireSubscribedAccess } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import * as controller from './messaging.controller';
import { campaignSchema, emailCampaignSchema, estimateSchema, historySchema, sendOneSchema } from './messaging.validators';

const router = Router();

/**
 * Sending is money and reputation, so it is rate limited independently of the
 * global API limiter.
 *
 * The wallet balance was the only brake before this: a scripted loop could fire
 * campaigns as fast as the gateway would take them. Generous enough that no
 * real operator will notice, tight enough that a loop cannot run away.
 */
const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: isProd ? 60 : 5_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Per workspace, not per IP: several tills share one office connection.
  keyGenerator: (req) => String(req.ctx?.tenantId ?? req.ip),
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many messages sent in the last hour. Try again shortly.',
    },
  },
});

// Marketing is a paid tier feature. Starter can see that it exists - the status
// endpoint answers "available: false" so the UI can offer an upgrade - but
// nothing that composes, estimates or sends is reachable without the flag.
const smsFeature = requireFeature('smsMarketing', 'SMS marketing');
const emailFeature = requireFeature('emailMarketing', 'Email marketing');
// An unsubscribed workspace can reach only its wallet and subscription;
// this module is locked entirely until a plan is active.
router.use(authenticate, resolveTenant, requireSubscribedAccess);

// Messaging is a customer-marketing feature, so it rides on the customer
// permissions rather than introducing a parallel set.
// Marketing has its OWN permissions. It previously borrowed the customer ones,
// which meant any cashier who could view customers could also spend the
// workspace's wallet on campaigns.
router.get('/status', requirePermission(PERMISSIONS.MARKETING_VIEW), controller.status);
router.get('/estimate', smsFeature, requirePermission(PERMISSIONS.MARKETING_VIEW), validate({ query: estimateSchema }), controller.estimate);
router.get('/sms', smsFeature, requirePermission(PERMISSIONS.MARKETING_VIEW_HISTORY), validate({ query: historySchema }), controller.history);
router.get('/campaigns', requirePermission(PERMISSIONS.MARKETING_VIEW_HISTORY), validate({ query: historySchema }), controller.campaigns);

router.post(
  '/sms',
  sendLimiter,
  requireActiveSubscription,
  smsFeature,
  requirePermission(PERMISSIONS.MARKETING_SEND_SMS),
  validate({ body: sendOneSchema }),
  controller.sendOne,
);
router.post(
  '/campaigns',
  sendLimiter,
  requireActiveSubscription,
  smsFeature,
  requirePermission(PERMISSIONS.MARKETING_CREATE_CAMPAIGN, PERMISSIONS.MARKETING_SEND_SMS),
  validate({ body: campaignSchema }),
  controller.sendCampaign,
);
router.post(
  '/email-campaigns',
  sendLimiter,
  requireActiveSubscription,
  emailFeature,
  requirePermission(PERMISSIONS.MARKETING_CREATE_CAMPAIGN, PERMISSIONS.MARKETING_SEND_EMAIL),
  validate({ body: emailCampaignSchema }),
  controller.sendEmailCampaign,
);

export default router;
