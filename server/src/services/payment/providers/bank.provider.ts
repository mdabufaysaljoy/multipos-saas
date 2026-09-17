import { PAYMENT_PROVIDERS } from '../../../config/constants';
import { PaymentProviderNotConfiguredError } from '../PaymentProvider';
import type {
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentProvider,
  VerifyPaymentResult,
  WebhookRequest,
  WebhookResult,
} from '../PaymentProvider';

/**
 * Placeholder for a card/bank gateway (SSLCommerz, Stripe, an acquirer API).
 * Registered but unconfigured, so it never appears as a payable option.
 */
export class BankPaymentProvider implements PaymentProvider {
  readonly name = PAYMENT_PROVIDERS.BANK;
  readonly displayName = 'Bank / Card';

  isConfigured(): boolean {
    return false;
  }

  supportsRecurring(): boolean {
    return true;
  }

  async initiatePayment(_input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    throw new PaymentProviderNotConfiguredError(this.name);
  }

  async verifyPayment(_id: string): Promise<VerifyPaymentResult> {
    throw new PaymentProviderNotConfiguredError(this.name);
  }

  async handleWebhook(_request: WebhookRequest): Promise<WebhookResult> {
    return { verified: false, providerTransactionId: null, status: null, amountMinor: null, currency: null, paidAt: null };
  }
}
