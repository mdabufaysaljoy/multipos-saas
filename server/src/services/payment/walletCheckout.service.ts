import type { Types } from 'mongoose';
import { PAYMENT_PURPOSES, PAYMENT_STATUS } from '../../config/constants';
import { PaymentModel } from '../../models/Payment';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { applyProviderReport, resumeActivation } from './paymentConfirmation.service';
import { paymentRegistry } from './registry';
import type { VerifyPaymentResult } from './PaymentProvider';

/**
 * Confirming a gateway wallet top-up, on demand.
 *
 * A customer coming back from a hosted checkout has proved nothing: the
 * browser's query string is the BROWSER's account of what happened, and it is
 * not read here at all. All this takes is which payment to ask about; the
 * answer comes from the gateway, and is applied by the same rules a webhook
 * goes through, so a forged return can only ever cause a redundant question.
 *
 * It exists because the webhook may be slow - or unreachable, as it is from a
 * laptop - and someone who has just paid should see their money rather than a
 * pending notice.
 */
export async function confirmPayment(tenantId: Types.ObjectId, paymentId: Types.ObjectId, expectedPurpose?: string) {
  // Scoped to the workspace, so a payment id from elsewhere is indistinguishable from a missing one.
  const payment = await PaymentModel.findOne({ _id: paymentId, tenantId }).lean();
  if (!payment) throw ApiError.notFound('Payment not found');
  const purpose = (payment.metadata as { purpose?: string } | undefined)?.purpose ?? PAYMENT_PURPOSES.SUBSCRIPTION_PURCHASE;
  if (expectedPurpose && purpose !== expectedPurpose) {
    throw ApiError.badRequest('This payment is not a wallet top-up');
  }

  if (payment.status === PAYMENT_STATUS.PAID) {
    // An activation interrupted after the payment was confirmed finishes here.
    await resumeActivation(payment._id);
    return { ...(await PaymentModel.findById(payment._id).lean()), purpose };
  }
  if (payment.status !== PAYMENT_STATUS.PENDING) return { ...payment, purpose };
  if (!payment.providerTransactionId) throw ApiError.badRequest('This payment has no provider reference to verify');

  await paymentRegistry.refresh();
  const provider = paymentRegistry.get(payment.provider);
  let report: VerifyPaymentResult;
  try {
    report = provider.completePayment
      ? await provider.completePayment(payment.providerTransactionId)
      : await provider.verifyPayment(payment.providerTransactionId);
  } catch (error) {
    logger.warn('Could not confirm a payment with the provider', {
      provider: payment.provider,
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw new ApiError('PROVIDER_UNAVAILABLE', 'The payment provider could not confirm this payment right now. Please try again in a moment.');
  }

  const result = await applyProviderReport(payment._id, report, 'verify');
  if (result.outcome === 'unverifiable') {
    throw ApiError.conflict('The provider did not confirm the amount, so the payment stays pending for review.');
  }
  return { ...(result.payment as Record<string, unknown>), purpose };
}
