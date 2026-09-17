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
import { confirmSnsSubscription, fetchAwsCertificate, parseSnsMessage, verifySnsSignature, type CertFetcher } from '../bkash/sns';

export interface BkashConfig {
  appKey: string;
  appSecret: string;
  username: string;
  password: string;
  /** e.g. https://tokenized.sandbox.bka.sh/v1.2.0-beta (sandbox) or https://tokenized.pay.bka.sh/v1.2.0-beta (live). */
  baseUrl: string;
  /** The SNS topic bKash publishes this merchant's notifications to. Webhooks are refused without it. */
  webhookTopicArn: string;
  timeoutMs?: number;
  /** Test seams; production uses the AWS-restricted defaults. */
  certFetcher?: CertFetcher;
  confirmSubscription?: (url: string) => Promise<void>;
  /** Hosts the customer may be sent to, besides the API host. */
  checkoutHosts?: string[];
}

export class BkashApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: string,
  ) {
    super(message);
    this.name = 'BkashApiError';
  }
}

type BkashPayload = Record<string, unknown> & { statusCode?: string; statusMessage?: string };

/** Renew a little before bKash's stated expiry, so a token never dies mid-request. */
const TOKEN_RENEW_MARGIN_MS = 60_000;
const DEFAULT_CHECKOUT_HOSTS = ['bka.sh', 'bkash.com'];

const unverifiedWebhook: WebhookResult = {
  verified: false,
  providerTransactionId: null,
  status: null,
  amountMinor: null,
  currency: null,
  paidAt: null,
};

const pickString = (source: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 100);
  }
  return null;
};

/**
 * bKash Tokenized Checkout.
 *
 *   create  -> the customer approves on bKash's page -> bKash redirects the
 *   browser to our callback -> execute -> payment status.
 *
 * Every state this adapter reports comes from bKash's API, never from the
 * browser and never from the body of a notification. Amounts are exact decimal
 * strings converted to minor units without floating point, and the caller
 * (payment confirmation) refuses anything whose amount or currency is off.
 *
 * Credentials and tokens are held in memory only and never logged.
 */
export class BkashPaymentProvider implements PaymentProvider {
  readonly name = PAYMENT_PROVIDERS.BKASH;
  readonly displayName = 'bKash';

  private token: { idToken: string; refreshToken: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(private readonly config: BkashConfig) {}

  isConfigured(): boolean {
    const { appKey, appSecret, username, password, baseUrl } = this.config;
    return Boolean(appKey && appSecret && username && password && baseUrl);
  }

  supportsRecurring(): boolean {
    // Tokenized agreements (saved wallets) are not used; every renewal is a new checkout.
    return false;
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    this.assertConfigured();
    if (!input.reference || !input.callbackUrl) {
      throw new Error('A bKash checkout needs our payment reference and a callback URL');
    }

    const response = await this.authorised('/tokenized/checkout/create', {
      mode: '0011',
      payerReference: String(input.tenantId),
      callbackURL: input.callbackUrl,
      amount: minorToDecimalString(input.amountMinor),
      currency: input.currency.toUpperCase(),
      intent: 'sale',
      merchantInvoiceNumber: input.reference,
    });

    if (response.statusCode !== '0000' || typeof response.paymentID !== 'string' || typeof response.bkashURL !== 'string') {
      throw new BkashApiError(`bKash refused to create the payment: ${response.statusMessage ?? 'unknown error'}`, response.statusCode);
    }
    // The amount bKash will charge must be exactly the amount we asked for.
    if (decimalStringToMinor(response.amount) !== input.amountMinor) {
      throw new BkashApiError('bKash created the payment for a different amount');
    }
    this.assertCheckoutUrl(response.bkashURL);

    return { providerTransactionId: response.paymentID, redirectUrl: response.bkashURL, status: 'pending' };
  }

  /** The payment's current state, from bKash. */
  async verifyPayment(paymentID: string): Promise<VerifyPaymentResult> {
    this.assertConfigured();
    const response = await this.authorised('/tokenized/checkout/payment/status', { paymentID });
    if (response.statusCode !== '0000') {
      // Not a statement that the payment failed - only that bKash would not say.
      return { providerTransactionId: paymentID, status: 'pending', amountMinor: null, currency: null, paidAt: null, failureReason: response.statusMessage };
    }
    return this.toResult(paymentID, response);
  }

  /**
   * Executes a payment the customer approved. Safe to repeat: if execute is
   * refused (not approved yet, already completed, cancelled, expired) the
   * payment's status is asked for instead, so the answer is always bKash's.
   */
  async completePayment(paymentID: string): Promise<VerifyPaymentResult> {
    this.assertConfigured();
    const executed = await this.authorised('/tokenized/checkout/execute', { paymentID });
    if (executed.statusCode === '0000' && typeof executed.transactionStatus === 'string') return this.toResult(paymentID, executed);
    return this.verifyPayment(paymentID);
  }

  /**
   * bKash payment notifications, delivered by Amazon SNS.
   *
   * Accepted only when the message is from the configured topic AND its AWS
   * signature verifies. Even then its contents are not applied: it returns the
   * payment it names with `refetch`, and the caller asks bKash's API.
   */
  async handleWebhook(request: WebhookRequest): Promise<WebhookResult> {
    const message = parseSnsMessage(request.rawBody);
    if (!message) return unverifiedWebhook;
    if (!(await verifySnsSignature(message, this.config.certFetcher ?? fetchAwsCertificate))) return unverifiedWebhook;

    // A genuine AWS delivery - but anyone can own an SNS topic, so it must be OURS.
    // The topic ARN is not a secret; logging it is how an operator finds the value
    // for BKASH_WEBHOOK_TOPIC_ARN from bKash's first subscription confirmation.
    if (!this.config.webhookTopicArn || message.TopicArn !== this.config.webhookTopicArn) {
      logger.warn('Rejected a signed SNS message from an unexpected topic', {
        topicArn: message.TopicArn,
        type: message.Type,
        topicConfigured: Boolean(this.config.webhookTopicArn),
      });
      return unverifiedWebhook;
    }

    if (message.Type === 'SubscriptionConfirmation') {
      await (this.config.confirmSubscription ?? confirmSnsSubscription)(message.SubscribeURL as string);
      logger.info('Confirmed the bKash notification subscription', { topicArn: message.TopicArn });
      return { ...unverifiedWebhook, verified: true };
    }
    if (message.Type !== 'Notification') return { ...unverifiedWebhook, verified: true };

    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(message.Message);
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
    } catch {
      // A notification we cannot read names no payment.
    }

    return {
      ...unverifiedWebhook,
      verified: true,
      providerTransactionId: pickString(body, ['paymentID', 'paymentId']),
      reference: pickString(body, ['merchantInvoiceNumber', 'merchantInvoice']),
      refetch: true,
    };
  }

  // ---------------------------------------------------------------- internals

  private assertConfigured(): void {
    if (!this.isConfigured()) throw new PaymentProviderNotConfiguredError(this.name);
  }

  private toResult(paymentID: string, payload: BkashPayload): VerifyPaymentResult {
    const transactionStatus = String(payload.transactionStatus ?? '');
    const status =
      transactionStatus === 'Completed'
        ? 'paid'
        : transactionStatus === 'Cancelled'
          ? 'cancelled'
          : ['Failed', 'Declined', 'Expired'].includes(transactionStatus)
            ? 'failed'
            : 'pending';
    return {
      providerTransactionId: paymentID,
      status,
      amountMinor: decimalStringToMinor(payload.amount),
      currency: typeof payload.currency === 'string' ? payload.currency.toUpperCase() : null,
      paidAt: status === 'paid' ? new Date() : null,
      failureReason: status === 'failed' || status === 'cancelled' ? `bKash reported the payment as ${transactionStatus}` : undefined,
      raw: { transactionStatus, trxID: typeof payload.trxID === 'string' ? payload.trxID : null },
    };
  }

  /** The customer is only ever sent to bKash, never to a host a response names. */
  private assertCheckoutUrl(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BkashApiError('bKash returned an invalid checkout URL');
    }
    const api = new URL(this.config.baseUrl);
    const hosts = this.config.checkoutHosts ?? DEFAULT_CHECKOUT_HOSTS;
    const isApiHost = url.hostname === api.hostname && url.protocol === api.protocol;
    const isBkashHost = url.protocol === 'https:' && hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    if (!isApiHost && !isBkashHost) throw new BkashApiError('bKash returned a checkout URL on an unexpected host');
  }

  /** An API call with the access token, re-authenticating once if bKash rejects it. */
  private async authorised(path: string, body: Record<string, unknown>, retried = false): Promise<BkashPayload> {
    const idToken = await this.idToken();
    try {
      return await this.post(path, body, { authorization: idToken, 'x-app-key': this.config.appKey });
    } catch (error) {
      if (!retried && error instanceof BkashApiError && error.statusCode === 'HTTP_401') {
        this.token = null;
        return this.authorised(path, body, true);
      }
      throw error;
    }
  }

  private async post(path: string, body: Record<string, unknown>, headers: Record<string, string>): Promise<BkashPayload> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
      redirect: 'error',
    });
    if (response.status === 401) throw new BkashApiError('bKash rejected the access token', 'HTTP_401');
    if (!response.ok) throw new BkashApiError(`bKash responded with HTTP ${response.status}`, `HTTP_${response.status}`);
    const payload = (await response.json().catch(() => null)) as BkashPayload | null;
    if (!payload || typeof payload !== 'object') throw new BkashApiError('bKash returned an unreadable response');
    return payload;
  }

  private idToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_RENEW_MARGIN_MS > Date.now()) return Promise.resolve(this.token.idToken);
    // One token request at a time: a burst of checkouts shares a single grant.
    this.tokenRequest ??= this.fetchToken().finally(() => {
      this.tokenRequest = null;
    });
    return this.tokenRequest;
  }

  private async fetchToken(): Promise<string> {
    const credentials = { username: this.config.username, password: this.config.password };
    const previous = this.token;
    if (previous?.refreshToken) {
      try {
        const refreshed = await this.post(
          '/tokenized/checkout/token/refresh',
          { app_key: this.config.appKey, app_secret: this.config.appSecret, refresh_token: previous.refreshToken },
          credentials,
        );
        if (refreshed.statusCode === '0000' && typeof refreshed.id_token === 'string') return this.storeToken(refreshed);
      } catch (error) {
        logger.warn('bKash token refresh failed; requesting a new token', { error: error instanceof Error ? error.message : 'unknown' });
      }
    }

    const granted = await this.post(
      '/tokenized/checkout/token/grant',
      { app_key: this.config.appKey, app_secret: this.config.appSecret },
      credentials,
    );
    if (granted.statusCode !== '0000' || typeof granted.id_token !== 'string') {
      throw new BkashApiError(`bKash refused to grant an access token: ${granted.statusMessage ?? 'unknown error'}`, granted.statusCode);
    }
    return this.storeToken(granted);
  }

  private storeToken(payload: BkashPayload): string {
    const ttlSeconds = Number(payload.expires_in);
    this.token = {
      idToken: payload.id_token as string,
      refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
      expiresAt: Date.now() + (Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : 50 * 60 * 1000),
    };
    return this.token.idToken;
  }
}
