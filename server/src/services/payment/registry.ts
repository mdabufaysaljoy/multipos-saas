import { env } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import type { PaymentProvider } from './PaymentProvider';
import { ManualPaymentProvider } from './providers/manual.provider';
import { BkashPaymentProvider } from './providers/bkash.provider';
import { NagadPaymentProvider } from './providers/nagad.provider';
import { BankPaymentProvider } from './providers/bank.provider';
import { UddoktaPayProvider } from './providers/uddoktapay.provider';

/**
 * Provider lookup. Application code depends on the PaymentProvider interface
 * and this registry only - adding a gateway means adding one file and one line
 * here, with no change to subscription or billing logic.
 */
class PaymentProviderRegistry {
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(providers: PaymentProvider[]) {
    providers.forEach((provider) => this.providers.set(provider.name, provider));
  }

  get(name: string): PaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) throw ApiError.badRequest(`Unknown payment provider "${name}"`);
    return provider;
  }

  /** Only providers with credentials present are offered to customers. */
  listAvailable(): { name: string; displayName: string; supportsRecurring: boolean }[] {
    return [...this.providers.values()]
      .filter((provider) => provider.isConfigured())
      .map((provider) => ({
        name: provider.name,
        displayName: provider.displayName,
        supportsRecurring: provider.supportsRecurring(),
      }));
  }

  listAll(): { name: string; displayName: string; configured: boolean; supportsRecurring: boolean }[] {
    return [...this.providers.values()].map((provider) => ({
      name: provider.name,
      displayName: provider.displayName,
      configured: provider.isConfigured(),
      supportsRecurring: provider.supportsRecurring(),
    }));
  }
}

export const paymentRegistry = new PaymentProviderRegistry([
  new ManualPaymentProvider(),
  new BkashPaymentProvider({
    appKey: process.env.BKASH_APP_KEY ?? '',
    appSecret: process.env.BKASH_APP_SECRET ?? '',
    username: process.env.BKASH_USERNAME ?? '',
    password: process.env.BKASH_PASSWORD ?? '',
    baseUrl: process.env.BKASH_BASE_URL ?? '',
    webhookTopicArn: process.env.BKASH_WEBHOOK_TOPIC_ARN ?? '',
  }),
  new NagadPaymentProvider({
    merchantId: process.env.NAGAD_MERCHANT_ID ?? '',
    privateKey: process.env.NAGAD_PRIVATE_KEY ?? '',
    publicKey: process.env.NAGAD_PUBLIC_KEY ?? '',
    baseUrl: process.env.NAGAD_BASE_URL ?? '',
    webhookSecret: process.env.NAGAD_WEBHOOK_SECRET ?? '',
  }),
  new UddoktaPayProvider({
    apiKey: process.env.UDDOKTAPAY_API_KEY ?? '',
    // Sandbox: https://sandbox.uddoktapay.com - production is the merchant's own installation.
    baseUrl: process.env.UDDOKTAPAY_BASE_URL ?? '',
  }),
  new BankPaymentProvider(),
]);

export { env };
