import { PAYMENT_PROVIDERS } from '../../../config/constants';
import { logger } from '../../../utils/logger';
import { fetchWithDnsFallback } from '../../../utils/fetchWithDnsFallback';
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
 * Implemented against ZiniPay's published API and Postman collection:
 *   POST {base}/v1/payment/create  { cus_name, cus_email, amount, metadata,
 *                                    redirect_url, cancel_url, webhook_url }
 *                                 -> { status, message, payment_url }
 *   POST {base}/v1/payment/verify  { invoice_id }
 *                                 -> { cus_name, cus_email, amount,
 *                                      invoice_id, payment_method,
 *                                      transaction_id,
 *                                      status: PENDING|COMPLETED|FAILED }
 *   webhook: { invoice_id, status }
 *
 * THE INVOICE ID COMES OUT OF THE PAYMENT URL, and it is NOT `val_id`.
 *
 * Checked against the live API, because the published sources disagree: the
 * PDF documents a `val_id`, the Postman collection has no such field, and the
 * real create response returns BOTH `payment_url` and `val_id` - two different
 * UUIDs. Asking verify about each settles it:
 *
 *   payment_url last segment -> 200, the invoice
 *   val_id                   -> 404 "Invoice not found"
 *
 * So `val_id` is something else and must never be used to correlate a payment;
 * doing so fails on every real one. The id is the last segment of
 * `payment_url` (whose path also carries a brand slug, hence "last segment"
 * rather than a fixed position), captured at create time and stored as the
 * provider transaction id. ZiniPay's own Postman test extracts it the same way.
 *
 * THE WEBHOOK IS NOT PROOF. It carries no signature and no shared secret -
 * anyone who learns the URL can post `status=true` to it. So it is treated as
 * what it is, a nudge saying "this invoice moved", and the money is confirmed
 * by calling verify. That is also ZiniPay's own documented merchant flow:
 * receive callback, then verify. `refetch: true` is how this codebase says it.
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

/**
 * The invoice id, read off the hosted payment URL.
 *
 * `https://secure.zinipay.com/payment/INVOICE_ID` -> `INVOICE_ID`. ZiniPay's
 * own Postman collection extracts it exactly this way, because the create
 * response does not return it as a field and nothing else ever will.
 */
function invoiceIdFrom(paymentUrl: string): string {
  const withoutQuery = paymentUrl.split(/[?#]/)[0].replace(/\/+$/, '');
  const last = withoutQuery.split('/').pop() ?? '';
  return last.trim();
}

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

/**
 * Turns a failed call into something a human can act on.
 *
 * `fetch` reports almost everything as "fetch failed", with the real cause one
 * level down. The common one in practice is no route to the gateway at all -
 * a firewall, or a host without outbound access - which looks identical to a
 * rejected key unless it is spelled out.
 */
function describeCallFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return `ZiniPay did not answer within ${Math.round(timeoutMs / 1000)}s`;
  }
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `could not reach api.zinipay.com from this server (${code}) - check the network and any firewall`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${message} (${code})` : message;
}

export class ZiniPayProvider implements PaymentProvider {
  readonly name = PAYMENT_PROVIDERS.ZINIPAY;
  readonly displayName = 'ZiniPay';

  constructor(private config: ZiniPayConfig) {}

  /**
   * Swaps in credentials read from platform settings.
   *
   * Same shape as the SMTP provider: the environment bootstraps a fresh
   * install, and whatever the platform admin saves afterwards wins. Callers
   * reload before use rather than trusting whatever was loaded at boot.
   */
  configure(config: ZiniPayConfig) {
    this.config = config;
  }

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
      const timeoutMs = this.config.timeoutMs ?? 15_000;
      const response = await fetchWithDnsFallback(
        this.url(path),
        {
          method: 'POST',
          headers: {
            // The documented preferred header. The query-string forms ZiniPay
            // also accepts are deliberately not used: an API key in a URL ends
            // up in access logs and proxy history.
            'zini-api-key': this.config.apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          timeoutMs,
        },
        // Worth saying once per call rather than never: the gateway works, but
        // its published address does not, and only they can fix that.
        (detail) =>
          logger.warn('ZiniPay was reached through its sibling domain: the address published for it did not answer', {
            host: detail.host,
            via: detail.via,
          }),
      );
      const payload = (await response.json().catch(() => ({}))) as ZiniPayPayload;
      if (!response.ok) {
        throw new Error(text(payload.message) || `ZiniPay returned HTTP ${response.status}`);
      }
      return payload;
    } catch (error) {
      // A gateway that cannot be reached and a gateway that says no are very
      // different problems - one is the network, the other is the request or
      // the key - and a bare "fetch failed" hides which. Say which.
      throw new Error(describeCallFailure(error, this.config.timeoutMs ?? 15_000));
    } finally {
      clearTimeout(timer);
    }
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    const reference = input.reference ?? '';

    const payload = await this.call('/v1/payment/create', {
      cus_name: text(input.metadata?.customerName) || 'Customer',
      cus_email: text(input.metadata?.customerEmail) || 'billing@example.com',
      // ZiniPay takes a decimal amount; money is held here in minor units and
      // only ever converted at the boundary.
      amount: minorToDecimalString(input.amountMinor),
      // Our own id, so a human reading their dashboard can find the payment
      // this invoice belongs to. Their cap is 1 KB, so it stays small. It is
      // NOT a correlation key - verify and the webhook do not echo metadata.
      metadata: { payment_id: reference },
      redirect_url: input.returnUrl ?? '',
      cancel_url: input.cancelUrl ?? '',
      // The POST notification endpoint, which is not the browser callback.
      webhook_url: input.webhookUrl ?? input.callbackUrl ?? '',
    });

    const paymentUrl = text(payload.payment_url);
    if (!paymentUrl) throw new Error(text(payload.message) || 'ZiniPay did not return a payment URL');

    // THE INVOICE ID IS THE LAST SEGMENT OF THE PAYMENT URL.
    //
    // Nothing else returns it: the create response is only status, message and
    // payment_url, and neither verify nor the webhook echoes our metadata
    // back. So the id is read off the URL here - exactly what ZiniPay's own
    // Postman collection does in its Create Invoice test - and stored as the
    // provider transaction id. It is then the single key that ties the
    // webhook, the verify call and this payment together.
    const invoiceId = invoiceIdFrom(paymentUrl);
    if (!invoiceId) {
      throw new Error('ZiniPay returned a payment URL with no invoice id in it');
    }

    return {
      providerTransactionId: invoiceId,
      redirectUrl: paymentUrl,
      status: 'pending',
      raw: payload as Record<string, unknown>,
    };
  }

  /**
   * Asks ZiniPay what really happened. This is the only thing that can mark a
   * payment paid.
   *
   * The id is the one captured from the payment URL at create time, which is
   * the only identifier the gateway ever gives us for an invoice.
   */
  async verifyPayment(invoiceId: string): Promise<VerifyPaymentResult> {
    const payload = await this.call('/v1/payment/verify', { invoice_id: invoiceId });
    const reported = text(payload.status).toUpperCase();
    const status = reported === 'COMPLETED' ? 'paid' : reported === 'PENDING' ? 'pending' : 'failed';

    return {
      providerTransactionId: text(payload.invoice_id) || invoiceId,
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

    // Documented as a JSON body; some callbacks arrive as a query string, so
    // both are read. The only field that identifies the payment is
    // `invoice_id`, which is why it is captured at create time.
    const body = (request.parsedBody ?? {}) as ZiniPayPayload;
    const query = (request.query ?? {}) as ZiniPayPayload;
    const invoiceId = text(body.invoice_id) || text(query.invoice_id);

    if (!invoiceId) {
      logger.warn('Rejected a ZiniPay webhook that named no invoice');
      return unverifiedWebhook;
    }

    return {
      verified: true,
      providerTransactionId: invoiceId,
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
