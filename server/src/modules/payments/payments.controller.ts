import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { PAYMENT_STATUS } from '../../config/constants';
import { env } from '../../config/env';
import { PaymentModel, type PaymentDoc } from '../../models/Payment';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { resolvePage } from '../../utils/pagination';
import { logger } from '../../utils/logger';
import { body, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { paymentRegistry } from '../../services/payment/registry';
import type { PaymentProvider, VerifyPaymentResult } from '../../services/payment/PaymentProvider';
import { applyProviderReport, resumeActivation } from '../../services/payment/paymentConfirmation.service';
import { startCheckout } from './checkout.service';
import type { CheckoutInput } from '../subscriptions/subscriptions.validators';
import type { ListSubscriptionsInput } from '../subscriptions/subscriptions.validators';
import { presentPayments } from '../../services/billing/invoice.service';

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
    PaymentModel.find({ tenantId: ctx.tenantId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean<(PaymentDoc & { _id: Types.ObjectId })[]>(),
    PaymentModel.countDocuments({ tenantId: ctx.tenantId }),
  ]);

  // Only what the customer may see: no review notes, approver names, idempotency keys or provider metadata.
  paginated(res, await presentPayments(items), buildPageMeta(page, limit, total));
});

/**
 * Starts a gateway payment: records it as PENDING, then asks the provider to
 * create it and hands back the provider's payment page. Nothing is ever marked
 * paid here - only the provider's own confirmation (callback, verify or a
 * verified notification) can do that.
 */
export const checkout = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<CheckoutInput>(req);
  const result = await startCheckout(ctx, input);
  created(res, { paymentId: result.paymentId, redirectUrl: result.redirectUrl, status: result.status });
});

/** Asks the provider for the state, finalising an approved payment when the provider needs that. */
const askProvider = (provider: PaymentProvider, providerTransactionId: string): Promise<VerifyPaymentResult> =>
  provider.completePayment ? provider.completePayment(providerTransactionId) : provider.verifyPayment(providerTransactionId);

/**
 * Confirms a payment by asking the PROVIDER, not the browser. The client may
 * trigger this, but the answer always comes from the gateway, and it is applied
 * by the same confirmation rules as a webhook.
 */
export const verify = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { paymentId } = body<{ paymentId: Types.ObjectId }>(req);

  const payment = await PaymentModel.findOne({ _id: paymentId, tenantId: ctx.tenantId }).lean();
  if (!payment) throw ApiError.notFound('Payment not found');

  if (payment.status === PAYMENT_STATUS.PAID) {
    // Finish an activation interrupted after the payment was confirmed.
    await resumeActivation(payment._id);
    return ok(res, await PaymentModel.findById(payment._id).lean());
  }
  if (payment.status !== PAYMENT_STATUS.PENDING) return ok(res, payment);
  if (!payment.providerTransactionId) throw ApiError.badRequest('This payment has no provider reference to verify');

  const provider = paymentRegistry.get(payment.provider);
  let verification: VerifyPaymentResult;
  try {
    verification = await askProvider(provider, payment.providerTransactionId);
  } catch (error) {
    logger.warn('Payment verification with the provider failed', { provider: payment.provider, error: error instanceof Error ? error.message : 'unknown' });
    throw new ApiError('PROVIDER_UNAVAILABLE', 'The payment provider could not confirm this payment right now. Please try again later.');
  }

  const result = await applyProviderReport(payment._id, verification, 'verify');
  if (result.outcome === 'unverifiable') {
    throw ApiError.conflict('The provider did not confirm the amount and currency, so the payment stays pending for review.');
  }
  if (result.outcome === 'failed' && verification.status === 'paid') {
    throw ApiError.badRequest(result.reason ?? 'The payment did not match the price');
  }
  ok(res, result.payment);
});

/** The single place the callback may send the browser: the app's own subscription page. */
const appReturnUrl = (result: 'success' | 'pending' | 'failed', paymentId?: Types.ObjectId) => {
  const origin = env.CLIENT_ORIGIN.split(',')[0].trim();
  const url = new URL('/subscription', origin);
  url.searchParams.set('payment', result);
  if (paymentId) url.searchParams.set('ref', String(paymentId));
  return url.toString();
};

/**
 * The provider sends the customer's browser here after the payment page.
 *
 * The query string is the BROWSER's account and is never believed: `status`
 * only decides whether to ask the provider to finalise, and what the provider
 * answers is what gets applied. A browser saying "cancel" never cancels a
 * payment either - it simply stays pending, so a forged callback cannot void a
 * payment the customer then completes. The redirect always goes to the app.
 */
export const callback = asyncHandler(async (req: Request, res: Response) => {
  const providerName = String(req.params.provider);
  const paymentID = typeof req.query.paymentID === 'string' ? req.query.paymentID.trim().slice(0, 100) : '';

  let provider: PaymentProvider;
  try {
    provider = paymentRegistry.get(providerName);
  } catch {
    return res.redirect(303, appReturnUrl('failed'));
  }
  if (!paymentID || !provider.isConfigured()) return res.redirect(303, appReturnUrl('failed'));

  const payment = await PaymentModel.findOne({ provider: provider.name, providerTransactionId: paymentID }).select('_id').lean();
  if (!payment) return res.redirect(303, appReturnUrl('failed'));

  let report: VerifyPaymentResult;
  try {
    report = req.query.status === 'success' ? await askProvider(provider, paymentID) : await provider.verifyPayment(paymentID);
  } catch (error) {
    logger.warn('Could not confirm a payment on return from the provider', { provider: provider.name, error: error instanceof Error ? error.message : 'unknown' });
    return res.redirect(303, appReturnUrl('pending', payment._id));
  }

  const outcome = await applyProviderReport(payment._id, report, 'callback');
  const status = (outcome.payment as { status?: string }).status;
  const result = status === PAYMENT_STATUS.PAID ? 'success' : status === PAYMENT_STATUS.PENDING ? 'pending' : 'failed';
  return res.redirect(303, appReturnUrl(result, payment._id));
});

/** Deliberately identical for every rejected delivery, so a prober learns nothing. */
const acknowledgeOnly = (res: Response) => res.status(202).json({ success: true, data: { received: true } });
const received = (res: Response) => res.status(200).json({ success: true, data: { received: true } });

/**
 * Provider webhook. The signature is verified inside the provider adapter; an
 * unverified payload is logged and discarded without touching any subscription.
 */
export const webhook = asyncHandler(async (req: Request, res: Response) => {
  const providerName = String(req.params.provider);
  let provider: PaymentProvider;
  try {
    provider = paymentRegistry.get(providerName);
  } catch {
    logger.warn('Webhook for an unknown payment provider', { provider: providerName.slice(0, 40) });
    return acknowledgeOnly(res);
  }

  const rawBody =
    typeof req.body === 'string'
      ? req.body
      : ((req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})));

  const result = await provider.handleWebhook({
    headers: req.headers as Record<string, string | string[] | undefined>,
    rawBody,
    parsedBody: req.body,
  });

  if (!result.verified) {
    logger.warn('Rejected an unverified payment webhook', { provider: providerName });
    return acknowledgeOnly(res);
  }

  // A notification that only names a payment: ask the provider for its real state.
  if (result.refetch) {
    const lookup = result.providerTransactionId
      ? { provider: provider.name, providerTransactionId: result.providerTransactionId }
      : result.reference && Types.ObjectId.isValid(result.reference)
        ? { provider: provider.name, _id: new Types.ObjectId(result.reference) }
        : null;
    const payment = lookup ? await PaymentModel.findOne(lookup).select('_id providerTransactionId').lean() : null;
    if (!payment) {
      logger.warn('A verified notification named no payment we know', { provider: providerName });
      return received(res);
    }
    // Some providers (UddoktaPay) only issue their transaction id once the
    // customer reaches the hosted page, so the notification is the first time
    // we learn it. Record it before asking them about it.
    let providerTransactionId = payment.providerTransactionId;
    if (result.providerTransactionId && result.providerTransactionId !== providerTransactionId) {
      await PaymentModel.updateOne({ _id: payment._id }, { $set: { providerTransactionId: result.providerTransactionId } });
      providerTransactionId = result.providerTransactionId;
    }
    if (!providerTransactionId) {
      logger.warn('A verified notification named a payment with no provider id', { provider: providerName });
      return received(res);
    }
    let report: VerifyPaymentResult;
    try {
      report = await provider.verifyPayment(providerTransactionId);
    } catch (error) {
      logger.warn('Could not check a notified payment with the provider', { provider: providerName, error: error instanceof Error ? error.message : 'unknown' });
      // Not 2xx, so the notification is delivered again later.
      return res.status(503).json({ success: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Try again later' } });
    }
    const outcome = await applyProviderReport(payment._id, report, 'webhook');
    if (outcome.outcome === 'failed' || outcome.outcome === 'unverifiable') {
      logger.warn('Notified payment was not activated', { paymentId: String(payment._id), outcome: outcome.outcome, reason: outcome.reason });
    }
    return received(res);
  }

  if (!result.providerTransactionId || !result.status) {
    logger.warn('A verified webhook carried no transaction or status', { provider: providerName });
    return received(res);
  }

  const payment = await PaymentModel.findOne({ provider: providerName, providerTransactionId: result.providerTransactionId })
    .select('_id')
    .lean();
  if (!payment) {
    logger.warn('A verified webhook referenced an unknown payment', { provider: providerName });
    return received(res);
  }

  const outcome = await applyProviderReport(
    payment._id,
    { status: result.status, amountMinor: result.amountMinor, currency: result.currency, paidAt: result.paidAt, failureReason: result.failureReason },
    'webhook',
  );
  if (outcome.outcome === 'failed' || outcome.outcome === 'unverifiable') {
    logger.warn('Webhook payment was not activated', { paymentId: String(payment._id), outcome: outcome.outcome, reason: outcome.reason });
  }

  // 200 for every processed delivery, so the provider stops retrying.
  return received(res);
});
