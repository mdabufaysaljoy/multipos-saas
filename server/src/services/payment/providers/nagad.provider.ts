import crypto from 'crypto';
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

interface NagadConfig {
  merchantId: string;
  privateKey: string;
  publicKey: string;
  baseUrl: string;
  webhookSecret: string;
}

/**
 * Nagad Merchant API skeleton. Same policy as bKash: structure now, network
 * calls in phase 2, never a fabricated success.
 */
export class NagadPaymentProvider implements PaymentProvider {
  readonly name = PAYMENT_PROVIDERS.NAGAD;
  readonly displayName = 'Nagad';

  constructor(private readonly config: NagadConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.merchantId && this.config.privateKey && this.config.baseUrl);
  }

  supportsRecurring(): boolean {
    return false;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) throw new PaymentProviderNotConfiguredError(this.name);
  }

  async initiatePayment(_input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    this.assertConfigured();
    // TODO(phase-2): /check-out/initialize/{merchantId}/{orderId} then /complete.
    throw new Error('Nagad checkout is not enabled yet');
  }

  async verifyPayment(_providerTransactionId: string): Promise<VerifyPaymentResult> {
    this.assertConfigured();
    // TODO(phase-2): GET /verify/payment/{paymentRefId}.
    throw new Error('Nagad verification is not enabled yet');
  }

  async handleWebhook(request: WebhookRequest): Promise<WebhookResult> {
    const signature = request.headers['x-nagad-signature'];
    const verified = this.verifySignature(request.rawBody, Array.isArray(signature) ? signature[0] : signature);
    return {
      verified,
      providerTransactionId: null,
      status: null,
      amountMinor: null,
      paidAt: null,
      raw: verified ? request.parsedBody : undefined,
    };
  }

  private verifySignature(rawBody: Buffer | string, signature?: string): boolean {
    if (!this.config.webhookSecret || !signature) return false;
    const expected = crypto.createHmac('sha256', this.config.webhookSecret).update(rawBody).digest('hex');
    const provided = Buffer.from(signature, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (provided.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(provided, expectedBuf);
  }
}
