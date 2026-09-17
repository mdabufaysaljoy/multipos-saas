import { ApiError } from '../../utils/ApiError';
import { AlphaSmsProvider } from './providers/alpha.provider';
import { MockSmsProvider } from './providers/mock.provider';
import { isProd } from '../../config/env';
import { PlatformSettingsModel } from '../../models/PlatformSettings';
import type { SmsProvider } from './SmsProvider';

/**
 * SMS provider lookup. Mirrors the payment registry so a second gateway is one
 * adapter plus one line here.
 */
class SmsProviderRegistry {
  private readonly providers = new Map<string, SmsProvider>();

  constructor(providers: SmsProvider[]) {
    providers.forEach((provider) => this.providers.set(provider.name, provider));
  }

  get(name: string): SmsProvider {
    const provider = this.providers.get(name);
    if (!provider) throw ApiError.badRequest(`Unknown SMS provider "${name}"`);
    return provider;
  }

  /** The provider actually usable on this deployment, if any. */
  active(): SmsProvider | null {
    return [...this.providers.values()].find((provider) => provider.isConfigured()) ?? null;
  }

  /**
   * Reloads gateway credentials from platform settings.
   *
   * Credentials used to be read from `process.env` once at module load, so
   * changing a gateway meant a redeploy. They now live in the database where a
   * platform admin can rotate them, and env values act as the initial default
   * for a fresh install.
   *
   * The api key is `select: false`, so it is fetched explicitly here and
   * nowhere else - it never reaches a settings response.
   */
  async refresh(): Promise<void> {
    const doc = await PlatformSettingsModel.findOne({ key: 'platform' }).select('+sms.apiKey').lean();
    if (!doc?.sms) return;

    const alpha = this.providers.get('alpha');
    if (alpha instanceof AlphaSmsProvider) {
      alpha.configure({
        // A disabled gateway is treated as having no credentials, so it cannot
        // be picked as the active provider.
        apiKey: doc.sms.enabled ? doc.sms.apiKey ?? '' : '',
        baseUrl: doc.sms.baseUrl || 'https://api.sms.net.bd',
        senderId: doc.sms.senderId ?? '',
      });
    }
  }

  /** Reloads, then answers which provider can send. */
  async activeAsync(): Promise<SmsProvider | null> {
    await this.refresh();
    return this.active();
  }

  listAll() {
    return [...this.providers.values()].map((provider) => ({
      name: provider.name,
      displayName: provider.displayName,
      configured: provider.isConfigured(),
    }));
  }
}

/**
 * The mock is only available outside production and only when explicitly
 * enabled, so a real deployment can never accidentally "send" through it.
 */
const useMock = !isProd && process.env.SMS_MOCK_ENABLED === 'true';

export const smsRegistry = new SmsProviderRegistry([
  new AlphaSmsProvider({
    apiKey: process.env.ALPHA_SMS_API_KEY ?? '',
    baseUrl: process.env.ALPHA_SMS_BASE_URL ?? 'https://api.sms.net.bd',
    senderId: process.env.ALPHA_SMS_SENDER_ID ?? '',
  }),
  ...(useMock ? [new MockSmsProvider()] : []),
]);
