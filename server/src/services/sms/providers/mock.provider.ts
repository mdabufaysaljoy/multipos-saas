import crypto from 'crypto';
import type { ProviderBalance, SendSmsInput, SendSmsResult, SmsProvider } from '../SmsProvider';

/**
 * A TEST DOUBLE, not a gateway.
 *
 * It never contacts a network and never delivers a message. It exists so the
 * billing path - wallet debit, per-segment pricing, failure refunds - can be
 * exercised end to end without live credentials.
 *
 * It is only registered when `SMS_MOCK_ENABLED=true` AND the environment is not
 * production, so it cannot be switched on by accident on a real deployment.
 * Numbers ending in "0000" are treated as failures so the refund path is
 * reachable in tests.
 */
export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock';
  readonly displayName = 'Mock (test double - does not deliver)';

  isConfigured(): boolean {
    return true;
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    const digits = input.to.replace(/\D/g, '');

    if (digits.endsWith('0000')) {
      return {
        success: false,
        providerMessageId: null,
        providerCostMinor: null,
        error: 'Mock provider: simulated delivery failure',
      };
    }

    return {
      success: true,
      providerMessageId: `mock_${crypto.randomUUID()}`,
      providerCostMinor: null,
      raw: { note: 'No message was actually delivered.' },
    };
  }

  async getBalance(): Promise<ProviderBalance> {
    return { balanceMinor: null, currency: null, raw: { note: 'Mock provider has no balance.' } };
  }
}
