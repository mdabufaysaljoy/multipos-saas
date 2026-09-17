import type { Types } from 'mongoose';

export interface InitiatePaymentInput {
  tenantId: Types.ObjectId;
  userId: Types.ObjectId | null;
  subscriptionId: Types.ObjectId | null;
  planId: Types.ObjectId | null;
  amountMinor: number;
  currency: string;
  /** Where the provider should send the customer back to. */
  returnUrl?: string;
  cancelUrl?: string;
  /** Our own payment id, echoed back by the provider (e.g. bKash merchantInvoiceNumber). */
  reference?: string;
  /** Server endpoint the provider sends the customer's browser back to. */
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface InitiatePaymentResult {
  /** Provider-side id we store to correlate the later webhook. */
  providerTransactionId: string;
  /** Present for redirect-based providers (bKash, Nagad, bank gateways). */
  redirectUrl?: string;
  status: 'pending' | 'paid';
  raw?: Record<string, unknown>;
}

export interface VerifyPaymentResult {
  providerTransactionId: string;
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
  amountMinor: number | null;
  currency: string | null;
  paidAt: Date | null;
  failureReason?: string;
  raw?: Record<string, unknown>;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Raw body bytes - required for signature verification. */
  rawBody: Buffer | string;
  parsedBody: unknown;
}

export interface WebhookResult {
  /** false when the signature does not verify; the caller must not act on it. */
  verified: boolean;
  providerTransactionId: string | null;
  status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'refunded' | null;
  /** A "paid" webhook activates nothing unless BOTH amount and currency are present. */
  amountMinor: number | null;
  currency: string | null;
  paidAt: Date | null;
  failureReason?: string;
  /** Our own payment id when the notification carries it instead of the provider's id. */
  reference?: string | null;
  /**
   * The notification only names a payment. Its claims must not be applied;
   * the caller asks the provider's API for the real state instead.
   */
  refetch?: boolean;
  raw?: unknown;
}

/**
 * Contract every payment integration implements.
 *
 * The application never learns that a payment succeeded from the browser. It
 * either verifies with the provider (`verifyPayment`) or validates a signed
 * webhook (`handleWebhook`); only those two paths can activate a subscription.
 */
export interface PaymentProvider {
  readonly name: string;
  readonly displayName: string;
  /** Whether credentials are configured; unconfigured providers stay hidden. */
  isConfigured(): boolean;
  /** True when the provider can charge a stored instrument without the user. */
  supportsRecurring(): boolean;

  initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentResult>;
  verifyPayment(providerTransactionId: string): Promise<VerifyPaymentResult>;
  /**
   * Optional: finalise a payment the customer has approved (bKash "execute"),
   * then report its state. Must be safe to call more than once.
   */
  completePayment?(providerTransactionId: string): Promise<VerifyPaymentResult>;
  handleWebhook(request: WebhookRequest): Promise<WebhookResult>;
  /** Optional: charge an existing authorisation for automatic renewal. */
  chargeRecurring?(input: InitiatePaymentInput & { providerSubscriptionId: string }): Promise<VerifyPaymentResult>;
  refund?(providerTransactionId: string, amountMinor: number): Promise<VerifyPaymentResult>;
}

export class PaymentProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`The "${provider}" payment provider is not configured on this server`);
    this.name = 'PaymentProviderNotConfiguredError';
  }
}
