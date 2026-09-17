import { isProd } from '../../config/env';
import rateLimit from 'express-rate-limit';
import { emptyBodySchema } from '../workspaces/workspaces.validators';
import { accountTopUpListSchema, accountTopUpSchema, topUpParams, accountWalletSummarySchema, accountWalletTransactionsSchema, hostedPaymentSchema, sendMoneyPaymentSchema } from '../wallet/wallet.validators';
import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { resolveAccount } from '../../middleware/account';
import { validate } from '../../middleware/validate';
import * as controller from './account.controller';
import { updateAccountSchema } from './account.validators';
import { accountInvoiceQuerySchema, accountPaymentQuerySchema, invoiceParams, accountStatementQuerySchema, accountReceiptQuerySchema, receiptParams } from '../subscriptions/invoices.validators';

const router = Router();

/**
 * The signed-in owner's platform account. There is no `/:accountId` route on
 * purpose: the account is always the caller's own, so there is no id to forge.
 */
router.use(authenticate, resolveAccount);

router.get('/', controller.me);
// Every owned workspace with its own subscription. The account is the caller's; nothing to forge.
router.get('/subscriptions', controller.subscriptions);
// Billing across every owned workspace, and the shared wallet.
router.get('/billing', controller.billing);
// The central dashboard: every workspace, its plan and renewal, and the POS types that can be added.
router.get('/dashboard', controller.dashboard);
// Every workspace's next renewal against the shared wallet.
router.get('/renewals', controller.renewals);
// Invoices and payments across every owned workspace.
router.get('/invoices', validate({ query: accountInvoiceQuerySchema }), controller.invoices);
router.get('/invoices/:invoiceId', validate({ params: invoiceParams }), controller.invoice);
router.get('/payments', validate({ query: accountPaymentQuerySchema }), controller.payments);
// The account wallet's statement, and receipts for top-ups.
router.get('/statement', validate({ query: accountStatementQuerySchema }), controller.statement);
router.get('/receipts', validate({ query: accountReceiptQuerySchema }), controller.receipts);
router.get('/receipts/:receiptId', validate({ params: receiptParams }), controller.receipt);

// Adding money to the account wallet from Billing, and withdrawing a request not yet verified.
const topUpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProd ? 10 : 1_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many top-up requests. Try again later.' } },
});
router.get('/payment-instructions', controller.paymentInstructions);
// Opening a payment for this account. Neither route credits anything: proof comes later.
router.get('/payment-methods', controller.paymentMethods);
router.post('/payments/send-money', topUpLimiter, validate({ body: sendMoneyPaymentSchema }), controller.openSendMoneyPayment);
router.post('/payments/hosted', topUpLimiter, validate({ body: hostedPaymentSchema }), controller.openHostedPayment);
// The account wallet: balance, spending by service, and every transaction across the account's workspaces.
router.get('/wallet', validate({ query: accountWalletSummarySchema }), controller.wallet);
router.get('/wallet/transactions', validate({ query: accountWalletTransactionsSchema }), controller.walletTransactions);
router.get('/top-ups', validate({ query: accountTopUpListSchema }), controller.topUps);
router.post('/top-ups', topUpLimiter, validate({ body: accountTopUpSchema }), controller.requestTopUp);
router.post('/top-ups/:topUpId/cancel', topUpLimiter, validate({ params: topUpParams, body: emptyBodySchema }), controller.cancelTopUp);
router.patch('/', validate({ body: updateAccountSchema }), controller.update);

export default router;
