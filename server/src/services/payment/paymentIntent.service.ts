import type { Types } from 'mongoose';
import { PAYMENT_PROVIDERS, PAYMENT_PURPOSES, PAYMENT_STATUS, type PaymentPurpose } from '../../config/constants';
import { env } from '../../config/env';
import { PaymentModel } from '../../models/Payment';
import { TenantModel } from '../../models/Tenant';
import { getPlatformSettings } from '../../models/PlatformSettings';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { minorToDecimalString } from './money';
import { paymentRegistry } from './registry';
import { accountKey } from './sms/parsers';

/**
 * Creating a payment INTENT, for any platform purpose.
 *
 * This is the one place a payment is opened, whatever it is for - a wallet
 * top-up, a subscription, a future add-on - and whoever will prove it later: a
 * hosted gateway, or a Send Money transfer proven by its SMS. It records what
 * is owed and what would settle it; it moves no money and grants nothing.
 *
 * Everything that matters is resolved on the server: the account comes from the
 * session's workspace, the amount from the caller's priced quote, the merchant
 * account from platform settings. A request supplies none of them.
 */

/** A Send Money claim stops being matchable after this, so a stale reference cannot be revived. */
const SEND_MONEY_TTL_MS = 24 * 60 * 60 * 1000;
/** Hosted checkouts are abandoned far sooner. */
const HOSTED_TTL_MS = 60 * 60 * 1000;

export interface PaymentIntentActor {
  accountId: Types.ObjectId;
  /** The workspace the payment is made from; the wallet is the account's. */
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  userName: string;
  email?: string;
}

export interface SendMoneyIntentInput {
  amountMinor: number;
  purpose: PaymentPurpose;
  /** The mobile-money service used, which selects the SMS parser later. */
  provider: string;
  /** The transaction id printed on the customer's receipt. */
  reference: string;
  /** The number the customer paid from. */
  customerPhone: string;
  workspaceId?: Types.ObjectId | null;
}

const normaliseReference = (value: string) => value.trim().toUpperCase();

/** The workspace must belong to this account - never taken on trust from a request. */
async function assertOwnedWorkspace(accountId: Types.ObjectId, workspaceId: Types.ObjectId) {
  const owned = await TenantModel.exists({ _id: workspaceId, accountId });
  if (!owned) throw ApiError.notFound('Workspace not found');
}

class PaymentIntentService {
  /**
   * Opens a payment the customer will settle by sending money to one of the
   * platform's merchant wallets. It is proven only when a registered device
   * reports the matching SMS; submitting it credits nothing at all.
   */
  async openSendMoney(actor: PaymentIntentActor, input: SendMoneyIntentInput) {
    if (input.workspaceId) await assertOwnedWorkspace(actor.accountId, input.workspaceId);

    const settings = await getPlatformSettings();
    const instruction = (settings.paymentInstructions ?? []).find(
      (row) => row.method === input.provider && row.isActive,
    );
    if (!instruction) {
      throw ApiError.badRequest('That payment method is not available at the moment', { reason: 'PROVIDER_UNAVAILABLE' });
    }

    const reference = normaliseReference(input.reference);
    try {
      const payment = await PaymentModel.create({
        tenantId: input.workspaceId ?? actor.tenantId,
        accountId: actor.accountId,
        userId: actor.userId,
        amountMinor: input.amountMinor,
        currency: settings.currency,
        provider: input.provider,
        purpose: input.purpose,
        status: PAYMENT_STATUS.PENDING,
        verificationMethod: 'none',
        // What the SMS will be matched against.
        rawReference: reference,
        // Stored as digits, so the SMS can be compared against it later.
        merchantAccount: accountKey(instruction.accountNumber),
        customerPhone: accountKey(input.customerPhone),
        expiresAt: new Date(Date.now() + SEND_MONEY_TTL_MS),
        metadata: {
          purpose: input.purpose,
          initiatedBy: actor.userName,
          payTo: instruction.accountNumber,
        },
      });

      logger.info('Payment intent opened', { paymentId: String(payment._id), purpose: input.purpose, provider: input.provider });
      return {
        paymentId: payment._id,
        status: payment.status,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        payTo: instruction.accountNumber,
        payToName: instruction.accountName,
        reference,
        expiresAt: payment.expiresAt,
      };
    } catch (error) {
      // The unique index on rawReference: one receipt, one payment, platform-wide.
      if ((error as { code?: number }).code === 11000) {
        throw ApiError.conflict('That transaction ID has already been submitted.', { reason: 'REFERENCE_ALREADY_USED' });
      }
      throw error;
    }
  }

  /**
   * Opens a payment settled on a provider's hosted page. The provider is asked
   * to start it; the customer is sent to the URL the provider returns. The
   * payment is proven later by the provider's API, never by the browser.
   */
  async openHostedCheckout(
    actor: PaymentIntentActor,
    input: { amountMinor: number; purpose: PaymentPurpose; provider: string; workspaceId?: Types.ObjectId | null },
  ) {
    if (input.workspaceId) await assertOwnedWorkspace(actor.accountId, input.workspaceId);

    const provider = paymentRegistry.get(input.provider);
    if (!provider.isConfigured()) {
      throw ApiError.badRequest(`${provider.displayName} payments are not available yet.`, { reason: 'PROVIDER_UNAVAILABLE' });
    }
    const settings = await getPlatformSettings();

    const payment = await PaymentModel.create({
      tenantId: input.workspaceId ?? actor.tenantId,
      accountId: actor.accountId,
      userId: actor.userId,
      amountMinor: input.amountMinor,
      currency: settings.currency,
      provider: provider.name,
      purpose: input.purpose,
      status: PAYMENT_STATUS.PENDING,
      verificationMethod: 'none',
      expiresAt: new Date(Date.now() + HOSTED_TTL_MS),
      // `metadata.purpose` is what the existing activation path reads to decide
      // between crediting the wallet and opening a subscription period.
      metadata: { purpose: input.purpose, initiatedBy: actor.userName },
    });

    try {
      const started = await provider.initiatePayment({
        tenantId: payment.tenantId,
        userId: actor.userId,
        subscriptionId: null,
        planId: null,
        amountMinor: input.amountMinor,
        currency: payment.currency,
        reference: String(payment._id),
        returnUrl: `${env.CLIENT_ORIGIN.split(',')[0].trim()}/wallet?payment=success`,
        cancelUrl: `${env.CLIENT_ORIGIN.split(',')[0].trim()}/wallet?payment=cancelled`,
        callbackUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/payments/webhook/${provider.name}`,
        metadata: { customerName: actor.userName, customerEmail: actor.email ?? '' },
      });

      await PaymentModel.updateOne(
        { _id: payment._id },
        { $set: { providerTransactionId: started.providerTransactionId, 'metadata.redirectUrl': started.redirectUrl ?? null } },
      );
      return {
        paymentId: payment._id,
        redirectUrl: started.redirectUrl ?? null,
        status: PAYMENT_STATUS.PENDING,
        amountMinor: input.amountMinor,
        currency: payment.currency,
        amount: minorToDecimalString(input.amountMinor),
      };
    } catch (error) {
      await PaymentModel.updateOne(
        { _id: payment._id, status: PAYMENT_STATUS.PENDING },
        { $set: { status: PAYMENT_STATUS.FAILED, failureReason: 'The payment could not be started with the provider' } },
      );
      logger.warn('Starting a hosted payment failed', { provider: provider.name, error: error instanceof Error ? error.message : 'unknown' });
      throw new ApiError('PROVIDER_UNAVAILABLE', `${provider.displayName} could not start the payment right now.`);
    }
  }

  /** Payment methods a customer may actually use right now. */
  async availableMethods() {
    const settings = await getPlatformSettings();
    const sendMoney = (settings.paymentInstructions ?? [])
      .filter((row) => row.isActive)
      .map((row) => ({ kind: 'send_money' as const, provider: row.method, label: row.label, payTo: row.accountNumber, payToName: row.accountName, steps: row.steps }));
    const hosted = paymentRegistry
      .listAvailable()
      .filter((row) => row.name === PAYMENT_PROVIDERS.UDDOKTAPAY)
      .map((row) => ({ kind: 'hosted' as const, provider: row.name, label: row.displayName }));
    return { sendMoney, hosted };
  }
}

export const paymentIntentService = new PaymentIntentService();
export { PAYMENT_PURPOSES };
