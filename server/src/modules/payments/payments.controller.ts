import type { Request, Response } from 'express';
import { PAYMENT_STATUS } from '../../config/constants';
import { PaymentModel } from '../../models/Payment';
import { SubscriptionModel } from '../../models/Subscription';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { resolvePage } from '../../utils/pagination';
import { logger } from '../../utils/logger';
import { body, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { paymentRegistry } from '../../services/payment/registry';
import { addInterval, buildPlanSnapshot } from '../../services/subscription/provisioning.service';
import { subscriptionService } from '../subscriptions/subscriptions.service';
import type { CheckoutInput } from '../subscriptions/subscriptions.validators';
import type { ListSubscriptionsInput } from '../subscriptions/subscriptions.validators';

/** Payment methods this deployment can actually accept. */
export const providers = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, paymentRegistry.listAvailable());
});

/** The tenant's own payment history. */
export const listMine = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = query<ListSubscriptionsInput>(req);
  const { page, limit, skip } = resolvePage(input);

  const [items, total] = await Promise.all([
    PaymentModel.find({ tenantId: ctx.tenantId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    PaymentModel.countDocuments({ tenantId: ctx.tenantId }),
  ]);

  paginated(res, items, buildPageMeta(page, limit, total));
});

/**
 * Starts a gateway payment. This creates a PENDING record and hands back a
 * redirect URL. It never marks anything paid - only `verify` (a server-to-server
 * check) or a signed webhook can do that.
 */
export const checkout = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<CheckoutInput>(req);

  const plan = await SubscriptionPlanModel.findOne({ _id: input.planId, isActive: true });
  if (!plan) throw ApiError.notFound('Plan not found');

  const provider = paymentRegistry.get(input.provider);
  if (!provider.isConfigured()) {
    throw ApiError.badRequest(`${provider.displayName} payments are not available yet. Please contact support to pay manually.`);
  }

  const result = await provider.initiatePayment({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    subscriptionId: null,
    planId: plan._id,
    amountMinor: plan.priceMinor,
    currency: plan.currency,
    returnUrl: input.returnUrl,
    cancelUrl: input.cancelUrl,
  });

  const payment = await PaymentModel.create({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    planId: plan._id,
    amountMinor: plan.priceMinor,
    currency: plan.currency,
    provider: provider.name,
    providerTransactionId: result.providerTransactionId,
    status: PAYMENT_STATUS.PENDING,
    metadata: { initiatedBy: ctx.userName },
  });

  created(res, { paymentId: payment._id, redirectUrl: result.redirectUrl ?? null, status: payment.status });
});

/**
 * Confirms a payment by asking the PROVIDER, not the browser. The client may
 * trigger this, but the answer always comes from the gateway.
 */
export const verify = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { paymentId } = body<{ paymentId: string }>(req);

  const payment = await PaymentModel.findOne({ _id: paymentId, tenantId: ctx.tenantId });
  if (!payment) throw ApiError.notFound('Payment not found');
  if (payment.status === PAYMENT_STATUS.PAID) return ok(res, payment.toObject());
  if (!payment.providerTransactionId) throw ApiError.badRequest('This payment has no provider reference to verify');

  const provider = paymentRegistry.get(payment.provider);
  const verification = await provider.verifyPayment(payment.providerTransactionId);

  if (verification.status !== 'paid') {
    payment.status = verification.status === 'failed' ? PAYMENT_STATUS.FAILED : payment.status;
    payment.failureReason = verification.failureReason ?? null;
    await payment.save();
    return ok(res, payment.toObject());
  }

  // Amount is re-checked against the plan so a tampered or partial payment
  // cannot activate a subscription.
  if (verification.amountMinor !== null && verification.amountMinor < payment.amountMinor) {
    payment.status = PAYMENT_STATUS.FAILED;
    payment.failureReason = 'The amount received was less than the plan price';
    await payment.save();
    throw ApiError.badRequest('The payment amount did not match the plan price');
  }

  payment.status = PAYMENT_STATUS.PAID;
  payment.paidAt = verification.paidAt ?? new Date();
  await payment.save();

  await activateFromPayment(payment._id);
  ok(res, payment.toObject());
});

/**
 * Provider webhook. The signature is verified inside the provider adapter; an
 * unverified payload is logged and discarded without touching any subscription.
 */
export const webhook = asyncHandler(async (req: Request, res: Response) => {
  const providerName = req.params.provider as string;
  const provider = paymentRegistry.get(providerName);

  const result = await provider.handleWebhook({
    headers: req.headers as Record<string, string | string[] | undefined>,
    rawBody: (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})),
    parsedBody: req.body,
  });

  if (!result.verified) {
    logger.warn('Rejected an unverified payment webhook', { provider: providerName });
    // 202 rather than 4xx: never confirm to a prober which payloads are valid.
    return res.status(202).json({ success: true, data: { received: true } });
  }

  if (result.providerTransactionId && result.status === 'paid') {
    const payment = await PaymentModel.findOne({
      provider: providerName,
      providerTransactionId: result.providerTransactionId,
    });

    // Idempotent: a redelivered webhook must not extend the subscription twice.
    if (payment && payment.status !== PAYMENT_STATUS.PAID) {
      payment.status = PAYMENT_STATUS.PAID;
      payment.paidAt = result.paidAt ?? new Date();
      await payment.save();
      await activateFromPayment(payment._id);
    }
  }

  res.status(200).json({ success: true, data: { received: true } });
});

/** Turns a confirmed payment into an active subscription period. */
async function activateFromPayment(paymentId: import('mongoose').Types.ObjectId) {
  const payment = await PaymentModel.findById(paymentId);
  if (!payment || payment.status !== PAYMENT_STATUS.PAID) return;

  const plan = await SubscriptionPlanModel.findById(payment.planId);
  if (!plan) {
    logger.error('Paid for a plan that no longer exists', { paymentId: String(paymentId) });
    return;
  }

  const existing = await SubscriptionModel.findOne({ tenantId: payment.tenantId }).sort({ createdAt: -1 });
  const now = new Date();
  // Renewing early stacks onto the remaining time rather than discarding it.
  const start = existing && existing.currentPeriodEnd > now ? existing.currentPeriodEnd : now;
  const end = addInterval(start, plan.interval);

  if (existing) {
    existing.status = 'active';
    existing.autoRenew = true;
    await existing.save();
  }

  const subscription = await SubscriptionModel.create({
    tenantId: payment.tenantId,
    planId: plan._id,
    planSnapshot: buildPlanSnapshot(plan),
    status: 'active',
    startedAt: now,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    autoRenew: true,
    provider: payment.provider,
    lastPaymentId: payment._id,
    isManual: false,
  });

  payment.subscriptionId = subscription._id;
  await payment.save();

  await subscriptionService.recordEvent(
    payment.tenantId,
    subscription._id,
    'activated',
    `Payment confirmed via ${payment.provider}`,
    { id: null, name: payment.provider },
    { paymentId: String(payment._id), amountMinor: payment.amountMinor },
  );
}
