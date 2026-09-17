import { SmsProviderNotConfiguredError, type ProviderBalance, type SendSmsInput, type SendSmsResult, type SmsProvider } from '../SmsProvider';
import { logger } from '../../../utils/logger';

interface AlphaConfig {
  apiKey: string;
  baseUrl: string;
  senderId: string;
}

/**
 * Alpha SMS (sms.net.bd).
 *
 * The API takes an api_key, a recipient list and the message body, and answers
 * with `{ error: 0, msg: ..., data: { request_id } }` on success. Anything with
 * a non-zero `error` is a failure and is surfaced as one - no silent success.
 */
export class AlphaSmsProvider implements SmsProvider {
  readonly name = 'alpha';
  readonly displayName = 'Alpha SMS';

  constructor(private config: AlphaConfig) {}

  /** Replaces the credentials at runtime, so rotating a key needs no redeploy. */
  configure(config: AlphaConfig): void {
    this.config = config;
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.baseUrl);
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    if (!this.isConfigured()) throw new SmsProviderNotConfiguredError(this.name);

    const body = new URLSearchParams({
      api_key: this.config.apiKey,
      msg: input.message,
      to: this.normalise(input.to),
      ...(input.senderId || this.config.senderId ? { sender_id: input.senderId ?? this.config.senderId } : {}),
    });

    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/sendsms`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        // A hung gateway must not hold a campaign open indefinitely.
        signal: AbortSignal.timeout(20_000),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: number;
        msg?: string;
        data?: { request_id?: string | number };
      };

      // Alpha signals failure in the body, not the HTTP status.
      if (!response.ok || (payload.error ?? 1) !== 0) {
        return {
          success: false,
          providerMessageId: null,
          providerCostMinor: null,
          error: payload.msg ?? `Gateway responded ${response.status}`,
          raw: payload,
        };
      }

      return {
        success: true,
        providerMessageId: payload.data?.request_id ? String(payload.data.request_id) : null,
        providerCostMinor: null,
        raw: payload,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown gateway error';
      logger.warn('Alpha SMS send failed', { error: message });
      return { success: false, providerMessageId: null, providerCostMinor: null, error: message };
    }
  }

  async getBalance(): Promise<ProviderBalance> {
    if (!this.isConfigured()) throw new SmsProviderNotConfiguredError(this.name);

    const response = await fetch(
      `${this.config.baseUrl.replace(/\/$/, '')}/user/balance/?api_key=${encodeURIComponent(this.config.apiKey)}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const payload = (await response.json().catch(() => ({}))) as { error?: number; data?: { balance?: string } };

    if ((payload.error ?? 1) !== 0) return { balanceMinor: null, currency: null, raw: payload };

    const balance = Number(payload.data?.balance ?? 0);
    return {
      balanceMinor: Number.isFinite(balance) ? Math.round(balance * 100) : null,
      currency: 'BDT',
      raw: payload,
    };
  }

  /** Bangladeshi numbers are sent as 8801XXXXXXXXX. */
  private normalise(to: string): string {
    const digits = to.replace(/\D/g, '');
    if (digits.startsWith('880')) return digits;
    if (digits.startsWith('0')) return `88${digits}`;
    if (digits.length === 10) return `880${digits}`;
    return digits;
  }
}
