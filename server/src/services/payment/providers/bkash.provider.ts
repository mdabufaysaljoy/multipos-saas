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

interface BkashConfig {
  appKey: string;
  appSecret: string;
  username: string;
  password: string;
  baseUrl: string;
  webhookSecret: string;
}

/**
 * bKash Tokenized Checkout skeleton.
 *
 * The HTTP calls are intentionally left unimplemented for phase 1: shipping a
 * provider that pretends to succeed is worse than one that refuses to run. The
 * shape, config handling and signature verification are in place so wiring the
 * real endpoints is a contained change that touches no other file.
 */
export class BkashPaymentProvider implements PaymentProvider {
  readonly name = PAYMENT_PROVIDERS.BKASH;
  readonly displayName = 'bKash';

  constructor(private readonly config: BkashConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.appKey && this.config.appSecret && this.config.username && this.config.baseUrl);
  }

  supportsRecurring(): boolean {
    // Tokenized checkout supports agreements; not enabled until phase 2.
    return false;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) throw new PaymentProviderNotConfiguredError(this.name);
  }

  async initiatePayment(_input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    this.assertConfigured();
    // TODO(phase-2): POST /tokenized/checkout/create with a grant-token header,
    // then return { providerTransactionId: paymentID, redirectUrl: bkashURL }.
    throw new Error('bKash checkout is not enabled yet');
  }

  async verifyPayment(_providerTransactionId: string): Promise<VerifyPaymentResult> {
    this.assertConfigured();
    // TODO(phase-2): POST /tokenized/checkout/execute then /payment/status.
    throw new Error('bKash verification is not enabled yet');
  }

  async handleWebhook(request: WebhookRequest): Promise<WebhookResult> {
    const signature = request.headers['x-bkash-signature'];
    const verified = this.verifySignature(request.rawBody, Array.isArray(signature) ? signature[0] : signature);

    if (!verified) {
      return { verified: false, providerTransactionId: null, status: null, amountMinor: null, paidAt: null };
    }

    // TODO(phase-2): map the verified payload onto WebhookResult.
    return { verified: true, providerTransactionId: null, status: null, amountMinor: null, paidAt: null, raw: request.parsedBody };
  }

  /** HMAC-SHA256 over the raw body, compared in constant time. */
  private verifySignature(rawBody: Buffer | string, signature?: string): boolean {
    if (!this.config.webhookSecret || !signature) return false;
    const expected = crypto.createHmac('sha256', this.config.webhookSecret).update(rawBody).digest('hex');
    const provided = Buffer.from(signature, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (provided.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(provided, expectedBuf);
  }
}
