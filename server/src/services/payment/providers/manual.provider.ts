import crypto from 'crypto';
import { PAYMENT_PROVIDERS } from '../../../config/constants';
import type {
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentProvider,
  VerifyPaymentResult,
  WebhookRequest,
  WebhookResult,
} from '../PaymentProvider';

/**
 * Offline payments recorded by a platform administrator (cash, bank transfer,
 * an agent collecting bKash by hand).
 *
 * It creates a PENDING record and nothing more. Marking it paid is an explicit
 * admin action through the platform API - this provider never self-approves.
 */
export class ManualPaymentProvider implements PaymentProvider {
  readonly name = PAYMENT_PROVIDERS.MANUAL;
  readonly displayName = 'Manual / Offline';

  isConfigured(): boolean {
    return true;
  }

  supportsRecurring(): boolean {
    return false;
  }

  async initiatePayment(_input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    return {
      providerTransactionId: `manual_${crypto.randomUUID()}`,
      status: 'pending',
    };
  }

  async verifyPayment(providerTransactionId: string): Promise<VerifyPaymentResult> {
    // There is no remote system to ask; status is whatever the admin recorded.
    return {
      providerTransactionId,
      status: 'pending',
      amountMinor: null,
      currency: null,
      paidAt: null,
    };
  }

  async handleWebhook(_request: WebhookRequest): Promise<WebhookResult> {
    return { verified: false, providerTransactionId: null, status: null, amountMinor: null, currency: null, paidAt: null };
  }
}
