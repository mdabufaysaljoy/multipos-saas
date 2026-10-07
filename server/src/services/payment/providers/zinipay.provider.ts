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
 * ZiniPay hosted checkout.
 *
 * Implemented against ZiniPay's published API only:
 *   POST {base}/v1/payment/create  { cus_name, cus_email, amount, metadata,
 *                                    redirect_url, cancel_url, val_id,
 *                                    webhook_url }
 *                                 -> { status, message, payment_url, val_id }
 *   POST {base}/v1/payment/verify  { invoice_id }
 *                                 -> { invoice_id, val_id, amount,
 *                                      payment_method, transaction_id,
 *                                      status: PENDING|COMPLETED|FAILED }
 *   webhook: { invoice_id, status, val_id } as a JSON body OR query string.
 *
 * THE WEBHOOK IS NOT PROOF. It carries no signature and no shared secret -
 * anyone who learns the URL can post `status=true` to it. So it is treated as
 * what it is, a nudge saying "this invoice moved", and the money is confirmed
 * by calling verify. That is also ZiniPay's own documented merchant flow:
 * receive callback, then verify. `refetch: true` is how this codebase says it.
 *
 * `val_id` is OUR payment id. ZiniPay echoes it back on both the verify
 * response and the webhook, which is what lets an unsigned notification name a
 * payment without being believed about its state.
 */
export interface ZiniPayConfig {
  apiKey: string;
  /** Origin only, e.g. https://api.zinipay.com - paths are appended. */
  baseUrl: string;
  timeoutMs?: number;
}

interface ZiniPayPayload {
  status?: unknown;
  message?: unknown;
  payment_url?: unknown;
  invoice_id?: unknown;
  val_id?: unknown;
  amount?: unknown;
  cus_name?: unknown;
  cus_email?: unknown;
  payment_method?: unknown;
  transaction_id?: unknown;
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

/** ZiniPay reports money as a number or a decimal string ("1200", "1200.50"). */
function toMinor(value: unknown): number | null {
  const raw = typeof value === 'number' ? String(value) : text(value);
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  try {
    return decimalStringToMinor(raw);
  } catch {
    return null;
  }
}

export class ZiniPayProvider implements PaymentProvider {
  readonly name = PAYMENT_PROVIDERS.ZINIPAY;
  readonly displayName = 'ZiniPay';

  constructor(private readonly config: ZiniPayConfig) {}

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

  private async call(path: string, body: Record<string, unknown>): Promise<ZiniPayPayload> {
    if (!this.isConfigured()) throw new PaymentProviderNotConfiguredError(this.name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    try {
      const response = await fetch(this.url(path), {
        method: 'POST',
        headers: {
          // The documented preferred header. The query-string forms ZiniPay
          // also accepts are deliberately not used: an API key in a URL ends up
          // in access logs and proxy history.
          'zini-api-key': this.config.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as ZiniPayPayload;
      if (!response.ok) {
        throw new Error(text(payload.message) || `ZiniPay returned HTTP ${response.status}`);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    const reference = input.reference ?? '';
    if (!reference) throw new Error('ZiniPay needs our own payment id as val_id to correlate the result');

    const payload = await this.call('/v1/payment/create', {
      cus_name: text(input.metadata?.customerName) || 'Customer',
      cus_email: text(input.metadata?.customerEmail) || 'billing@example.com',
      // ZiniPay takes a decimal amount; money is held here in minor units and
      // only ever converted at the boundary.
      amount: minorToDecimalString(input.amountMinor),
      // Our id travels twice: as val_id, which ZiniPay echoes on verify and
      // webhook, and in metadata for a human reading their dashboard. Their
      // metadata cap is 1 KB, so it stays small.
      val_id: reference,
      metadata: { payment_id: reference },
      redirect_url: input.returnUrl ?? '',
      cancel_url: input.cancelUrl ?? '',
      webhook_url: input.callbackUrl ?? '',
    });

    const paymentUrl = text(payload.payment_url);
    if (!paymentUrl) throw new Error(text(payload.message) || 'ZiniPay did not return a payment URL');

    return {
      // The invoice id only exists once the customer reaches the hosted page,
      // so our own id is the correlation key until the callback or webhook
      // hands back the real one.
      providerTransactionId: text(payload.val_id) || reference,
      redirectUrl: paymentUrl,
      status: 'pending',
      raw: payload as Record<string, unknown>,
    };
  }

  /**
   * Asks ZiniPay what really happened. This is the only thing that can mark a
   * payment paid.
   *
   * `invoice_id` is what the endpoint documents, and ZiniPay accepts our
   * `val_id` there too - which matters, because between creating the invoice
   * and the customer finishing we only hold our own id.
   */
  async verifyPayment(invoiceId: string): Promise<VerifyPaymentResult> {
    const payload = await this.call('/v1/payment/verify', { invoice_id: invoiceId });
    const reported = text(payload.status).toUpperCase();
    const status = reported === 'COMPLETED' ? 'paid' : reported === 'PENDING' ? 'pending' : 'failed';

    return {
      providerTransactionId: text(payload.invoice_id) || text(payload.val_id) || invoiceId,
      status,
      // Only a COMPLETED payment reports money. A pending or failed one
      // activates nothing, so it must not carry an amount that could be
      // mistaken for one.
      amountMinor: status === 'paid' ? toMinor(payload.amount) : null,
      currency: status === 'paid' ? 'BDT' : null,
      // ZiniPay's verify response carries no timestamp, so the moment we
      // confirmed it is the honest answer.
      paidAt: status === 'paid' ? new Date() : null,
      failureReason:
        status === 'failed' ? text(payload.message) || `ZiniPay reported the payment as ${reported || 'FAILED'}` : undefined,
      raw: payload as Record<string, unknown>,
    };
  }

  /**
   * A notification that an invoice moved.
   *
   * ZiniPay signs nothing and sends no shared secret, so there is no way to
   * authenticate the caller - which means `verified` here cannot mean "this
   * really came from ZiniPay", only "this is well-formed enough to name a
   * payment". It therefore NEVER reports a status, an amount or a time: it
   * names the payment and asks for a re-check, and the verify call decides.
   *
   * Posting a forged webhook at this endpoint achieves nothing beyond making
   * the server ask ZiniPay about a payment that already exists.
   */
  async handleWebhook(request: WebhookRequest): Promise<WebhookResult> {
    if (!this.isConfigured()) return unverifiedWebhook;

    // Documented as a JSON body OR a query string, so both are read.
    const body = (request.parsedBody ?? {}) as ZiniPayPayload;
    const query = (request.query ?? {}) as ZiniPayPayload;
    const invoiceId = text(body.invoice_id) || text(query.invoice_id);
    const valId = text(body.val_id) || text(query.val_id);

    if (!invoiceId && !valId) {
      logger.warn('Rejected a ZiniPay webhook that named no payment');
      return unverifiedWebhook;
    }

    return {
      verified: true,
      providerTransactionId: invoiceId || null,
      reference: valId || null,
      // The whole point: nothing in the body is believed. Ask the API.
      refetch: true,
      status: null,
      amountMinor: null,
      currency: null,
      paidAt: null,
      raw: body,
    };
  }
}
