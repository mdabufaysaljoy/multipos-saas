import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { idParam } from '../common/common.validators';
import * as controller from './wallet.controller';
import { topUpRequestSchema, usageListSchema, walletBreakdownSchema, walletHistorySchema } from './wallet.validators';

const router = Router();
router.use(authenticate, resolveTenant);

// The wallet is account-level money, so it sits behind the wallet permissions,
// which no subscription or POS permission implies. It is NOT behind requireActiveSubscription: an expired tenant
// must be able to top up in order to pay.
router.get('/', requirePermission(PERMISSIONS.WALLET_VIEW), controller.balance);
router.get('/breakdown', requirePermission(PERMISSIONS.WALLET_VIEW), validate({ query: walletBreakdownSchema }), controller.breakdown);
router.get('/transactions', requirePermission(PERMISSIONS.WALLET_VIEW), validate({ query: walletHistorySchema }), controller.history);

// Usage charges for paid services (SMS, email, AI, storage) and their prices.
router.get('/usage', requirePermission(PERMISSIONS.WALLET_VIEW), validate({ query: usageListSchema }), controller.usage);
router.get('/usage/prices', requirePermission(PERMISSIONS.SUBSCRIPTION_VIEW), controller.usagePrices);

router.get('/top-ups', requirePermission(PERMISSIONS.WALLET_VIEW), validate({ query: walletHistorySchema }), controller.listTopUps);
router.post('/top-ups', requirePermission(PERMISSIONS.WALLET_MANAGE), validate({ body: topUpRequestSchema }), controller.submitTopUp);
router.post('/top-ups/:id/cancel', requirePermission(PERMISSIONS.WALLET_MANAGE), validate({ params: idParam }), controller.cancelTopUp);
// The receipt for one of this workspace's own approved top-ups.
router.get('/top-ups/:id/receipt', requirePermission(PERMISSIONS.WALLET_VIEW), validate({ params: idParam }), controller.topUpReceipt);

export default router;
