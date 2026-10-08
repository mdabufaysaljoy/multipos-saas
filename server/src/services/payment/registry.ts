import { env } from '../../config/env';
import { HOSTED_PAYMENT_PROVIDERS } from '../../config/constants';
import { PlatformSettingsModel } from '../../models/PlatformSettings';
import { ApiError } from '../../utils/ApiError';
import type { PaymentProvider } from './PaymentProvider';
import { ManualPaymentProvider } from './providers/manual.provider';
import { BkashPaymentProvider } from './providers/bkash.provider';
import { NagadPaymentProvider } from './providers/nagad.provider';
import { BankPaymentProvider } from './providers/bank.provider';
import { UddoktaPayProvider } from './providers/uddoktapay.provider';
import { ZiniPayProvider } from './providers/zinipay.provider';

/**
 * Provider lookup. Application code depends on the PaymentProvider interface
 * and this registry only - adding a gateway means adding one file and one line
 * here, with no change to subscription or billing logic.
 */
class PaymentProviderRegistry {
  private readonly providers = new Map<string, PaymentProvider>();
  /**
   * Whether hand-confirmed transfers are offered. Held here because it decides
   * availability exactly as credentials do, and every caller that lists or
   * starts a payment already goes through this registry.
   */
  private manualEnabled = true;

  constructor(providers: PaymentProvider[]) {
    providers.forEach((provider) => this.providers.set(provider.name, provider));
  }

  get(name: string): PaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) throw ApiError.badRequest(`Unknown payment provider "${name}"`);
    return provider;
  }

  /**
   * Reloads credentials a platform admin can change, and reports which ways of
   * paying are switched on.
   *
   * Credentials live on the settings document, so reading whatever was loaded
   * at boot would serve a stale - or absent - gateway. Everything that offers
   * a payment option calls this first, exactly as the email and SMS services
   * reload before sending.
   *
   * The environment is the BOOTSTRAP: a key set there is used until one is
   * saved in settings, so a fresh install works before anybody opens the
   * screen.
   */
  async refresh(): Promise<{ manualEnabled: boolean }> {
    const settings = await PlatformSettingsModel.findOne({ key: 'platform' })
      // `+path` is ADDITIVE to the default selection, so this returns the whole
      // document plus the hidden key. Naming the parent as well collides.
      .select('+payments.zinipay.apiKey')
      .lean();
    const payments = settings?.payments;

    const zinipay = this.providers.get('zinipay') as ZiniPayProvider | undefined;
    if (zinipay) {
      const saved = payments?.zinipay;
      // `enabled` is a separate switch from "has a key": an operator turning
      // the gateway off should not have to delete their credentials to do it.
      const apiKey = saved?.enabled === false ? '' : (saved?.apiKey || process.env.ZINIPAY_API_KEY || '');
      zinipay.configure({
        apiKey,
        baseUrl: saved?.baseUrl || process.env.ZINIPAY_BASE_URL || 'https://api.zinipay.com',
      });
    }

    this.manualEnabled = payments?.manualEnabled !== false;
    return { manualEnabled: this.manualEnabled };
  }

  /**
   * Whether this provider may be used right now.
   *
   * Credentials are not the only question: manual transfers are always
   * "configured" - there is nothing to configure - so switching them off has
   * to be asked separately, or a customer could still start one from a stale
   * screen after an operator turned the slow path off.
   */
  isUsable(name: string): boolean {
    const provider = this.providers.get(name);
    if (!provider || !provider.isConfigured()) return false;
    if (name === 'manual' && !this.manualEnabled) return false;
    return true;
  }

  /**
   * Only providers that may actually be used are offered to customers.
   *
   * `kind` says whether paying means being taken to the provider's own
   * checkout, or declaring a transfer somebody then confirms - which is what a
   * screen needs in order to decide between a "Pay now" button and a form,
   * without keeping its own list of provider names.
   */
  listAvailable(): { name: string; displayName: string; kind: 'hosted' | 'manual'; supportsRecurring: boolean }[] {
    return [...this.providers.values()]
      .filter((provider) => this.isUsable(provider.name))
      .map((provider) => ({
        name: provider.name,
        displayName: provider.displayName,
        kind: (HOSTED_PAYMENT_PROVIDERS as readonly string[]).includes(provider.name) ? ('hosted' as const) : ('manual' as const),
        supportsRecurring: provider.supportsRecurring(),
      }));
  }

  /** `listAvailable`, after reloading what an admin may have changed. */
  async listAvailableAsync() {
    await this.refresh();
    return this.listAvailable();
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
  new ZiniPayProvider({
    apiKey: process.env.ZINIPAY_API_KEY ?? '',
    // https://api.zinipay.com for both sandbox and live; the key decides which.
    baseUrl: process.env.ZINIPAY_BASE_URL ?? 'https://api.zinipay.com',
  }),
  new BankPaymentProvider(),
]);

export { env };
