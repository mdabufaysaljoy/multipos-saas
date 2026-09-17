import { z } from 'zod';
import { supportedSmsProviders } from '../../services/payment/sms/parsers';

/**
 * What a reporting device may send. Deliberately narrow: a provider, the SMS
 * sender id, the message, and when it arrived. There is no field for an
 * account, an amount to credit, or a payment to complete - a device reports
 * evidence, and the backend decides what it means.
 */
export const smsEventSchema = z
  .object({
    provider: z.enum(supportedSmsProviders() as [string, ...string[]]),
    /** The SMS sender id as the handset received it, e.g. "bKash". */
    sender: z.string().trim().min(1).max(40),
    message: z.string().trim().min(1).max(500),
    receivedAt: z.coerce.date().optional(),
  })
  .strict();
export type SmsEventBody = z.infer<typeof smsEventSchema>;
