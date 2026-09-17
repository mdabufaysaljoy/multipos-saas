import crypto from 'crypto';
import { PAYMENT_PROVIDERS } from '../../../config/constants';
import { logger } from '../../../utils/logger';
import { decimalStringToMinor, minorToDecimalString } from '../money';
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
 * UddoktaPay hosted checkout.
 *
 * Implemented against UddoktaPay's published API only:
 *   POST {base}/api/checkout-v2   -> { status, message, payment_url }
 *   POST {base}/api/verify-payment { invoice_id }
 *        -> { status: COMPLETED|PENDING|ERROR, amount, charged_amount,
 *             transaction_id, sender_number, payment_method, date, metadata }
 *   webhook: the verify payload, authenticated ONLY by the RT-UDDOKTAPAY-API-KEY header.
 *
 * Because the webhook carries no signature - just a shared secret header - a
 * notification is never acted on directly. It is authenticated, then reported
 * with `refetch`, so the money is always confirmed by asking the API.
 *
 * The base URL is configuration, never hard-coded: sandbox is
 * https://sandbox.uddoktapay.com and production is the merchant's own
 * UddoktaPay installation.
 */
export interface UddoktaPayConfig {
  apiKey: string;
  /** Origin only, e.g. https://sandbox.uddoktapay.com - paths are appended. */
  baseUrl: string;
  timeoutMs?: number;
}

interface UddoktaPayPayload {
  status?: unknown;
  message?: unknown;
  payment_url?: unknown;
  invoice_id?: unknown;
  amount?: unknown;
  charged_amount?: unknown;
  fee?: unknown;
  transaction_id?: unknown;
  sender_number?: unknown;
  payment_method?: unknown;
  date?: unknown;
  metadata?: unknown;
}

const unverifiedWebhook: WebhookResult = {
  verified: false,
  providerTransactionId: null,
  status: null,
  amountMinor: null,
  currency: null,
  paidAt: null,
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** UddoktaPay reports money as a decimal string ("100", "1990.00"). */
function toMinor(value: unknown): number | null {
  const raw = typeof value === 'number' ? String(value) : text(value);
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  try {
    return decimalStringToMinor(raw);
  } catch {
    return null;
  }
}

/** Their `date` is a display timestamp; an unparseable one simply means "no time given". */
function toDate(value: unknown): Date | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const equalSecrets = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

export class UddoktaPayProvider implements PaymentProvider {
  readonly name = PAYMENT_PROVIDERS.UDDOKTAPAY;
  readonly displayName = 'UddoktaPay';

  constructor(private readonly config: UddoktaPayConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.baseUrl);
  }

  /** Hosted checkout only: there is no stored instrument to charge later. */
  supportsRecurring(): boolean {
    return false;
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async call(path: string, body: Record<string, unknown>): Promise<UddoktaPayPayload> {
    if (!this.isConfigured()) throw new PaymentProviderNotConfiguredError(this.name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    try {
      const response = await fetch(this.url(path), {
        method: 'POST',
        headers: {
          'RT-UDDOKTAPAY-API-KEY': this.config.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as UddoktaPayPayload;
      if (!response.ok) {
        throw new Error(text(payload.message) || `UddoktaPay returned HTTP ${response.status}`);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    // Our own payment id travels in metadata, so the webhook and the verify
    // response both name the payment they belong to.
    const payload = await this.call('/api/checkout-v2', {
      full_name: text(input.metadata?.customerName) || 'Customer',
      email: text(input.metadata?.customerEmail) || 'billing@example.com',
      amount: minorToDecimalString(input.amountMinor),
      metadata: { payment_id: input.reference ?? '' },
      redirect_url: input.returnUrl ?? '',
      cancel_url: input.cancelUrl ?? '',
      webhook_url: input.callbackUrl ?? '',
      return_type: 'GET',
    });

    const paymentUrl = text(payload.payment_url);
    if (!paymentUrl) throw new Error(text(payload.message) || 'UddoktaPay did not return a payment URL');

    return {
      // UddoktaPay issues its `invoice_id` only once the customer reaches the
      // hosted page, so our own id is the correlation key until then; the
      // callback and webhook replace it with the real invoice id.
      providerTransactionId: input.reference ?? '',
      redirectUrl: paymentUrl,
      status: 'pending',
      raw: payload as Record<string, unknown>,
    };
  }

  async verifyPayment(invoiceId: string): Promise<VerifyPaymentResult> {
    const payload = await this.call('/api/verify-payment', { invoice_id: invoiceId });
    const reported = text(payload.status).toUpperCase();
    const status = reported === 'COMPLETED' ? 'paid' : reported === 'PENDING' ? 'pending' : 'failed';

    return {
      providerTransactionId: text(payload.invoice_id) || invoiceId,
      status,
      // Only a COMPLETED payment reports money; anything else activates nothing.
      amountMinor: status === 'paid' ? toMinor(payload.amount) : null,
      currency: status === 'paid' ? 'BDT' : null,
      paidAt: status === 'paid' ? (toDate(payload.date) ?? new Date()) : null,
      failureReason: status === 'failed' ? text(payload.message) || 'UddoktaPay reported the payment as failed' : undefined,
      raw: payload as Record<string, unknown>,
    };
  }

  /**
   * Authenticates the notification by comparing the shared API key header, then
   * asks for a re-check. Nothing in the body is believed on its own.
   */
  async handleWebhook(request: WebhookRequest): Promise<WebhookResult> {
    if (!this.isConfigured()) return unverifiedWebhook;
    const header = request.headers['rt-uddoktapay-api-key'] ?? request.headers['RT-UDDOKTAPAY-API-KEY'];
    const presented = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
    if (!presented || !equalSecrets(String(presented), this.config.apiKey)) {
      logger.warn('Rejected an UddoktaPay webhook with a bad API key');
      return unverifiedWebhook;
    }

    const body = (request.parsedBody ?? {}) as UddoktaPayPayload;
    const metadata = (body.metadata ?? {}) as Record<string, unknown>;

    return {
      verified: true,
      providerTransactionId: text(body.invoice_id) || null,
      reference: text(metadata.payment_id) || null,
      // Authenticated, but still only a notification: confirm with the API.
      refetch: true,
      status: null,
      amountMinor: null,
      currency: null,
      paidAt: null,
      raw: body,
    };
  }
}
