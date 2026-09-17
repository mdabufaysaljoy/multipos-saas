import * as paymentDevices from './paymentDevices.controller';
import { isProd } from '../../config/env';
import rateLimit from 'express-rate-limit';
import { accountDocumentParams, accountListQuerySchema, accountParams, supportInvoiceQuerySchema, supportPaymentQuerySchema, supportReasonQuerySchema, supportReceiptQuerySchema, supportStatementQuerySchema, supportTopUpQuerySchema, supportWalletQuerySchema, walletAdjustmentSchema, walletReversalSchema, accountTransactionParams } from './accountsSupport.validators';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePlatformAdmin } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { idParam, objectId, paginationSchema , httpUrl } from '../common/common.validators';
import {
  assignSubscriptionSchema,
  extendSubscriptionSchema,
  setSubscriptionStatusSchema,
} from '../subscriptions/subscriptions.validators';
import { manualAdjustmentSchema } from '../wallet/wallet.validators';
import platformTenantRoutes from './platformTenant.routes';
import * as controller from './platform.controller';
import * as paymentOps from './paymentOps.controller';
import * as posProducts from './posProducts.controller';
import * as pricingAdmin from './pricingAdmin.controller';
import * as renewalsAdmin from './renewalsAdmin.controller';
import * as accountsSupport from './accountsSupport.controller';
import {
  listPricesSchema,
  planCodeParams,
  priceIdParams,
  schedulePriceSchema,
  setPriceActiveSchema,
  updateCatalogPlanSchema,
} from '../pricing/pricing.validators';
import { createPosProductSchema, posProductParams, updatePosProductSchema } from './posProducts.validators';
import { REFUND_METHODS, SUBSCRIPTION_ADJUSTMENTS } from '../../models/Payment';
import { PAYMENT_QUEUES } from '../../services/payment/paymentOperations.service';

const router = Router();

// The entire platform surface is gated behind the platform-admin role, which is
// kept logically separate from tenant administration.
router.use(authenticate, requirePlatformAdmin);

/**
 * Sensitive platform ACTIONS - moving customer money, changing what a customer
 * is subscribed to, suspending a workspace, editing the coupon catalogue.
 * Reads are left alone; this caps how fast a compromised or mistaken admin
 * session can act, and makes a scripted burst visible in the audit log.
 * Relaxed outside production so the end-to-end suite is not throttled.
 */
const adminActionLimiter = rateLimit({
  windowMs: 60_000,
  limit: isProd ? 60 : 20_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many administrative actions. Slow down.' } },
});

const listQuery = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  status: z.string().trim().max(30).optional(),
  tenantId: objectId.optional(),
});

router.get('/overview', controller.overview);

const analyticsQuery = z.object({
  preset: z.enum(['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'thisYear', 'custom']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sortBy: z.enum(['revenue', 'profit', 'orders']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

router.get('/analytics', validate({ query: analyticsQuery }), controller.analytics);
router.get('/analytics/workspaces', validate({ query: analyticsQuery }), controller.workspaceLeaderboard);

// POS product catalog: the platform-level definitions of each POS type.
router.get('/pos-products', posProducts.list);
router.post('/pos-products', validate({ body: createPosProductSchema }), posProducts.create);
router.get('/pos-products/:code', validate({ params: posProductParams }), posProducts.detail);
router.patch('/pos-products/:code', validate({ params: posProductParams, body: updatePosProductSchema }), posProducts.update);

// Universal plan catalog and pricing: platform admins only (this whole router).
router.get('/pricing/plans', pricingAdmin.listPlans);
router.patch('/pricing/plans/:code', validate({ params: planCodeParams, body: updateCatalogPlanSchema }), pricingAdmin.updatePlan);
router.get('/pricing/prices', validate({ query: listPricesSchema }), pricingAdmin.listPrices);
router.post('/pricing/prices', validate({ body: schedulePriceSchema }), pricingAdmin.schedulePrice);
router.patch('/pricing/prices/:id', validate({ params: priceIdParams, body: setPriceActiveSchema }), pricingAdmin.setPriceActive);
router.delete('/pricing/prices/:id', validate({ params: priceIdParams }), pricingAdmin.cancelScheduledPrice);

router.get('/settings', controller.getSettings);
router.get('/integrations', controller.integrations);
router.post('/integrations/smtp/test', controller.testSmtp);
router.post('/integrations/sms/test', controller.testSms);
router.get('/audit-log', validate({ query: listQuery.extend({ action: z.string().trim().max(60).optional() }) }), controller.auditLog);
router.patch(
  '/settings',
  validate({
    body: z.object({
      paymentInstructions: z
        .array(
          z.object({
            method: z.enum(['bkash', 'nagad', 'bank']),
            label: z.string().trim().min(1).max(60),
            accountNumber: z.string().trim().min(3).max(40),
            accountName: z.string().trim().max(80).optional().default(''),
            steps: z.array(z.string().trim().max(200)).max(8).default([]),
            isActive: z.boolean().default(true),
          }),
        )
        .max(6)
        .optional(),
      supportEmail: z.string().email().or(z.literal('')).optional(),
      supportPhone: z.string().trim().max(32).optional(),
      smsCostMinor: z.number().int().min(0).optional(),
      smtp: z
        .object({
          host: z.string().trim().max(200),
          port: z.number().int().min(1).max(65535),
          secure: z.boolean(),
          username: z.string().trim().max(200),
          // Blank leaves the stored password untouched.
          password: z.string().max(200).optional(),
          fromName: z.string().trim().max(120),
          fromEmail: z.string().email().or(z.literal('')),
          enabled: z.boolean(),
        })
        .optional(),
      emailCostMinor: z.number().int().min(0).optional(),
      // Per-use prices for AI and storage, in minor units.
      aiRequestCostMinor: z.number().int().min(0).max(100_000_000).optional(),
      storageGbMonthCostMinor: z.number().int().min(0).max(100_000_000).optional(),
      // Digest emails about payments needing attention; admins always receive them.
      paymentAlerts: z
        .object({
          enabled: z.boolean(),
          recipients: z.array(z.string().trim().toLowerCase().email('Enter valid email addresses')).max(10),
        })
        .strict()
        .optional(),
      sms: z
        .object({
          provider: z.enum(['alpha']),
          // Blank leaves the stored key untouched, exactly like the SMTP
          // password - otherwise re-saving the form would wipe the gateway.
          apiKey: z.string().trim().max(200).optional(),
          baseUrl: httpUrl,
          senderId: z.string().trim().max(32),
          enabled: z.boolean(),
        })
        .optional(),
    }),
  }),
  controller.updateSettings,
);

router.get('/tenants', validate({ query: listQuery }), controller.listTenants);
router.get('/tenants/:id', validate({ params: idParam }), controller.getTenant);
router.patch(
  '/tenants/:id/status',
  adminActionLimiter,
  validate({ params: idParam, body: z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().max(300).optional() }) }),
  controller.setTenantStatus,
);

// Support view of customer accounts. READ-ONLY; every detail read needs a reason and is audited.
router.get('/accounts', validate({ query: accountListQuerySchema }), accountsSupport.list);
router.get('/accounts/:accountId', validate({ params: accountParams, query: supportReasonQuerySchema }), accountsSupport.overview);
router.get('/accounts/:accountId/statement', validate({ params: accountParams, query: supportStatementQuerySchema }), accountsSupport.statement);
router.get('/accounts/:accountId/invoices', validate({ params: accountParams, query: supportInvoiceQuerySchema }), accountsSupport.invoices);
router.get('/accounts/:accountId/invoices/:documentId', validate({ params: accountDocumentParams, query: supportReasonQuerySchema }), accountsSupport.invoice);
router.get('/accounts/:accountId/receipts', validate({ params: accountParams, query: supportReceiptQuerySchema }), accountsSupport.receipts);
router.get('/accounts/:accountId/receipts/:documentId', validate({ params: accountDocumentParams, query: supportReasonQuerySchema }), accountsSupport.receipt);
router.get('/accounts/:accountId/payments', validate({ params: accountParams, query: supportPaymentQuerySchema }), accountsSupport.payments);
router.get('/accounts/:accountId/top-ups', validate({ params: accountParams, query: supportTopUpQuerySchema }), accountsSupport.topUps);
// The account wallet ledger, manual adjustments and compensating reversals. Never edits a posted row.
router.get('/accounts/:accountId/wallet', validate({ params: accountParams, query: supportWalletQuerySchema }), accountsSupport.wallet);
router.post('/accounts/:accountId/wallet/adjustments', adminActionLimiter, validate({ params: accountParams, body: walletAdjustmentSchema }), accountsSupport.adjustWallet);
router.post(
  '/accounts/:accountId/wallet/transactions/:transactionId/reverse',
  adminActionLimiter,
  validate({ params: accountTransactionParams, body: walletReversalSchema }),
  accountsSupport.reverseTransaction,
);

router.get('/customers', validate({ query: listQuery }), controller.listCustomers);
router.get('/users/unassigned', controller.unassignedUsers);
router.patch(
  '/users/:id',
  validate({
    params: idParam,
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      phone: z.string().trim().max(32).optional(),
      isActive: z.boolean().optional(),
    }),
  }),
  controller.updateUser,
);

router.post(
  '/workspaces',
  adminActionLimiter,
  validate({
    body: z.object({
      businessName: z.string().trim().min(2).max(160),
      // Ids are checked for shape here, so a malformed one is a 422 rather
      // than a cast error deeper in the handler.
      ownerUserId: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid user id').optional(),
      owner: z
        .object({
          name: z.string().trim().min(2).max(120),
          email: z.string().trim().toLowerCase().email(),
          phone: z.string().trim().max(32).optional(),
          password: z.string().min(8).max(128),
        })
        .optional(),
      planId: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid plan id').optional(),
      periods: z.number().int().min(1).max(60).optional(),
      storeName: z.string().trim().max(160).optional(),
      storeCode: z.string().trim().max(16).optional(),
    }),
  }),
  controller.createWorkspace,
);

router.get('/subscriptions', validate({ query: listQuery }), controller.listSubscriptions);
router.get('/subscriptions/expiring', controller.expiringSoon);
router.post('/subscriptions/run-renewals', validate({ body: z.object({}).strict() }), renewalsAdmin.runRenewals);
router.post('/subscriptions', adminActionLimiter, validate({ body: assignSubscriptionSchema }), controller.assignSubscription);
router.post(
  '/subscriptions/:id/extend',
  adminActionLimiter,
  validate({ params: idParam, body: extendSubscriptionSchema }),
  controller.extendSubscription,
);
router.patch(
  '/subscriptions/:id/status',
  adminActionLimiter,
  validate({ params: idParam, body: setSubscriptionStatusSchema }),
  controller.setSubscriptionStatus,
);

router.get('/upgrade-requests', validate({ query: listQuery }), controller.listUpgradeRequests);
router.post(
  '/upgrade-requests/:id/approve',
  validate({ params: idParam, body: z.object({ reviewNote: z.string().trim().max(500).optional() }) }),
  controller.approveUpgrade,
);
router.post(
  '/upgrade-requests/:id/reject',
  validate({ params: idParam, body: z.object({ reviewNote: z.string().trim().max(500).optional() }) }),
  controller.rejectUpgrade,
);

router.get('/top-ups', validate({ query: listQuery }), controller.listTopUps);
router.post(
  '/top-ups/:id/approve',
  validate({ params: idParam, body: z.object({ reviewNote: z.string().trim().max(500).optional() }) }),
  controller.approveTopUp,
);
router.post(
  '/top-ups/:id/reject',
  validate({ params: idParam, body: z.object({ reviewNote: z.string().trim().max(500).optional() }) }),
  controller.rejectTopUp,
);
router.get('/tenants/:id/wallet', validate({ params: idParam }), controller.tenantWallet);
router.post(
  '/tenants/:id/wallet/adjust',
  validate({ params: idParam, body: manualAdjustmentSchema }),
  controller.adjustWallet,
);

const couponBody = z
  .object({
  code: z.string().trim().min(3).max(32),
  description: z.string().trim().max(300).optional(),
  discountType: z.enum(['percent', 'fixed']),
  discountValue: z.number().int().min(1),
  maxDiscountMinor: z.number().int().min(0).optional(),
  minPurchaseMinor: z.number().int().min(0).optional(),
  applicablePlanIds: z.array(objectId).optional(),
  usageLimit: z.number().int().min(0).optional(),
  perTenantLimit: z.number().int().min(1).optional(),
  startsAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  isActive: z.boolean().optional(),
  })
  // The service writes the record from this object, so an unknown key - a
  // tenant id, a usage counter - is refused rather than carried into it.
  .strict();

// ------------------------------------------------ payment SMS devices and reconciliation
const deviceBody = z
  .object({
    label: z.string().trim().min(2).max(120),
    allowedProviders: z.array(z.string().trim().min(2).max(30)).max(10).default([]),
    merchantAccounts: z.array(z.string().trim().min(3).max(40)).max(20).default([]),
  })
  .strict();
const reasonBody = z.object({ reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(300) }).strict();

router.get('/payment-devices', paymentDevices.listDevices);
router.post('/payment-devices', adminActionLimiter, validate({ body: deviceBody }), paymentDevices.registerDevice);
router.post('/payment-devices/:id/rotate', adminActionLimiter, validate({ params: idParam }), paymentDevices.rotateDevice);
router.post('/payment-devices/:id/revoke', adminActionLimiter, validate({ params: idParam, body: reasonBody }), paymentDevices.revokeDevice);
router.get(
  '/payment-events',
  validate({ query: paginationSchema.extend({ outcome: z.enum(['matched', 'unmatched', 'duplicate', 'rejected']).optional() }) }),
  paymentDevices.listSmsEvents,
);
router.post('/payments/:id/manual-verify', adminActionLimiter, validate({ params: idParam, body: reasonBody }), paymentDevices.manuallyVerify);
router.post('/payments/:id/manual-reject', adminActionLimiter, validate({ params: idParam, body: reasonBody }), paymentDevices.manuallyReject);

router.get('/coupons', validate({ query: listQuery }), controller.listCoupons);
router.post('/coupons', adminActionLimiter, validate({ body: couponBody }), controller.createCoupon);
router.patch('/coupons/:id', adminActionLimiter, validate({ params: idParam, body: couponBody.partial() }), controller.updateCoupon);

// ------------------------------------------------------ payment operations
// Narrow by design: nothing here edits an amount or revives a final payment,
// and every action is written to the audit log.
router.get(
  '/payments',
  validate({
    query: paginationSchema.extend({
      queue: z.enum(PAYMENT_QUEUES).default('all'),
      provider: z.string().trim().max(30).optional(),
      tenantId: objectId.optional(),
    }),
  }),
  paymentOps.list,
);
router.get('/payments/summary', paymentOps.summary);
router.get('/payments/:id', validate({ params: idParam }), paymentOps.detail);
router.post('/payments/:id/recheck', validate({ params: idParam, body: z.object({}).strict() }), paymentOps.recheck);
router.post(
  '/payments/:id/mark-paid',
  validate({
    params: idParam,
    body: z
      .object({
        amountReceivedMinor: z.number().int().min(1).max(100_000_000),
        reference: z.string().trim().min(3, 'Enter the payment reference').max(120),
        note: z.string().trim().min(5, 'Explain how the payment was confirmed').max(300),
      })
      .strict(),
  }),
  paymentOps.markReceived,
);
router.post(
  '/payments/:id/refunds',
  validate({
    params: idParam,
    body: z
      .object({
        amountMinor: z.number().int().min(1).max(100_000_000),
        method: z.enum(REFUND_METHODS),
        reference: z.string().trim().min(3, 'Enter the refund reference').max(120),
        reason: z.string().trim().min(5, 'Explain why the refund was made').max(500),
      })
      .strict(),
  }),
  paymentOps.recordRefund,
);
router.post(
  '/payments/:id/subscription-action',
  validate({
    params: idParam,
    body: z
      .object({
        action: z.enum(SUBSCRIPTION_ADJUSTMENTS),
        until: z.coerce.date().optional(),
        reason: z.string().trim().min(5, 'Explain the change to the customer').max(300),
      })
      .strict()
      .superRefine((input, ctx) => {
        if (input.action === 'shorten' && !input.until) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['until'], message: 'Choose the new end date' });
        }
        if (input.action === 'end_now' && input.until) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['until'], message: 'Ending now takes no date' });
        }
      }),
  }),
  paymentOps.adjustSubscription,
);
router.post('/payments/alerts/send-now', validate({ body: z.object({}).strict() }), paymentOps.sendAlerts);
router.post(
  '/payments/:id/resolve-review',
  validate({ params: idParam, body: z.object({ note: z.string().trim().min(5, 'Explain how it was resolved').max(500) }).strict() }),
  paymentOps.resolveReview,
);

// Workspace-scoped management. Mounted here so the target tenant is always
// explicit in the URL and can never be inferred.
router.use('/workspaces/:tenantId', platformTenantRoutes);

export default router;
