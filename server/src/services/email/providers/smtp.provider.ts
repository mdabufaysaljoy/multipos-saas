import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from '../../../utils/logger';
import type { EmailProvider, SendEmailInput, SendEmailResult } from '../EmailProvider';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromName: string;
  fromEmail: string;
  enabled: boolean;
}

/**
 * SMTP delivery via nodemailer.
 *
 * Configuration lives in platform settings so an admin can change it at
 * runtime; the transport is rebuilt when those settings change rather than
 * being pinned at boot.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  readonly displayName = 'SMTP';

  private transporter: Transporter | null = null;
  private fingerprint = '';

  constructor(private config: SmtpConfig) {}

  /** Swaps in new settings without a restart. */
  configure(config: SmtpConfig) {
    this.config = config;
    const next = `${config.host}:${config.port}:${config.username}:${config.secure}`;
    if (next !== this.fingerprint) {
      this.transporter = null;
      this.fingerprint = next;
    }
  }

  isConfigured(): boolean {
    return Boolean(this.config.enabled && this.config.host && this.config.fromEmail);
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.isConfigured()) {
      return { success: false, providerMessageId: null, error: 'SMTP is not configured on this server.' };
    }

    try {
      const info = await this.transport().sendMail({
        from: this.config.fromName ? `"${this.config.fromName}" <${this.config.fromEmail}>` : this.config.fromEmail,
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      });
      return { success: true, providerMessageId: info.messageId ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown SMTP error';
      logger.warn('SMTP send failed', { error: message });
      return { success: false, providerMessageId: null, error: message };
    }
  }

  /** Verifies credentials without delivering anything. */
  async verify(): Promise<{ ok: boolean; error?: string }> {
    if (!this.isConfigured()) return { ok: false, error: 'SMTP is not configured.' };
    try {
      await this.transport().verify();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Verification failed' };
    }
  }

  private transport(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure,
        ...(this.config.username ? { auth: { user: this.config.username, pass: this.config.password } } : {}),
        connectionTimeout: 15_000,
      });
    }
    return this.transporter;
  }
}
