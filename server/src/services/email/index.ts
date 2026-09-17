import { getPlatformSettings } from '../../models/PlatformSettings';
import { PlatformSettingsModel } from '../../models/PlatformSettings';
import { UnconfiguredEmailProvider, type EmailProvider } from './EmailProvider';
import { SmtpEmailProvider } from './providers/smtp.provider';

/**
 * Email service.
 *
 * Shares the wallet-billing model with SMS: the platform admin sets a price per
 * email, and sending debits the tenant's wallet. Only the provider is missing,
 * so adding one is a single adapter behind `EmailProvider`.
 */
class EmailService {
  private fallback: EmailProvider = new UnconfiguredEmailProvider();
  private smtp = new SmtpEmailProvider({
    host: '',
    port: 587,
    secure: false,
    username: '',
    password: '',
    fromName: '',
    fromEmail: '',
    enabled: false,
  });

  /**
   * Reloads SMTP credentials from platform settings.
   *
   * The password is `select: false`, so it is fetched explicitly here and
   * nowhere else - it never reaches a tenant-facing response.
   */
  async refresh() {
    const doc = await PlatformSettingsModel.findOne({ key: 'platform' }).select('+smtp.password').lean();
    if (doc?.smtp) this.smtp.configure(doc.smtp as never);
    return this.smtp;
  }

  /** The active provider, or the refusing fallback when SMTP is off. */
  async provider(): Promise<EmailProvider> {
    await this.refresh();
    return this.smtp.isConfigured() ? this.smtp : this.fallback;
  }

  async verify() {
    await this.refresh();
    return this.smtp.verify();
  }

  async statusAsync() {
    await this.refresh();
    return {
      available: this.smtp.isConfigured(),
      provider: this.smtp.name,
      displayName: this.smtp.displayName,
    };
  }

  status() {
    return {
      available: this.smtp.isConfigured(),
      provider: this.smtp.name,
      displayName: this.smtp.displayName,
    };
  }

  /** Price per email, configured by the platform admin. */
  async costPerEmailMinor(): Promise<number> {
    const settings = await getPlatformSettings();
    return settings.emailCostMinor ?? 0;
  }
}

export const emailService = new EmailService();
export type { EmailProvider, SendEmailInput, SendEmailResult } from './EmailProvider';
