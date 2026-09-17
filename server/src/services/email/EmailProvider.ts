export interface SendEmailInput {
  to: string;
  subject: string;
  /** Plain-text body; `html` is optional for providers that support it. */
  text: string;
  html?: string;
  replyTo?: string;
}

export interface SendEmailResult {
  success: boolean;
  providerMessageId: string | null;
  error?: string;
}

/**
 * Contract for a transactional/marketing email gateway.
 *
 * No provider has been chosen yet, so only the abstraction and the billing
 * hook exist. When one is picked it slots in behind this interface exactly as
 * the SMS providers do - the wallet-deduction path is already built and shared.
 */
export interface EmailProvider {
  readonly name: string;
  readonly displayName: string;
  isConfigured(): boolean;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

/**
 * Placeholder used until a real provider is configured.
 *
 * It deliberately REFUSES to send rather than pretending to succeed: a silent
 * no-op would look like working email and lose real messages.
 */
export class UnconfiguredEmailProvider implements EmailProvider {
  readonly name = 'none';
  readonly displayName = 'Not configured';

  isConfigured(): boolean {
    return false;
  }

  async send(_input: SendEmailInput): Promise<SendEmailResult> {
    return {
      success: false,
      providerMessageId: null,
      error: 'No email provider is configured on this server.',
    };
  }
}
