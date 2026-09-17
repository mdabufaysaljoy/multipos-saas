import type { Types } from 'mongoose';
import { PAYMENT_STATUS, PAYMENT_PURPOSES } from '../../../config/constants';
import { PaymentModel } from '../../../models/Payment';
import { PaymentSmsEventModel, type SmsEventOutcome } from '../../../models/PaymentSmsEvent';
import type { PaymentDeviceDoc } from '../../../models/PaymentDevice';
import { logger } from '../../../utils/logger';
import { applyProviderReport } from '../paymentConfirmation.service';
import { accountKey, isKnownSender, parserFor, type ParsedPaymentSms } from './parsers';

/**
 * Turns a reported payment SMS into a verified payment - or into nothing.
 *
 * The device supplies EVIDENCE, never an instruction. It cannot name an
 * account, an amount to credit, or a payment to complete. This service:
 *
 *   1. checks the device may report this provider and merchant account,
 *   2. parses the message with that provider's own parser,
 *   3. records the event, which is where duplicates die: (provider, reference)
 *      is unique, so a message delivered ten times inserts once,
 *   4. looks for a PENDING payment the customer already created that matches on
 *      reference, amount, provider and merchant account, inside the time window,
 *   5. and only then reports it as paid through the SAME confirmation path every
 *      gateway uses, which credits the wallet exactly once.
 *
 * An event that matches nothing is kept as `unmatched` for a platform admin.
 */

/** How long after a payment was created its SMS may still arrive. */
const MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SmsEventInput {
  provider: string;
  sender: string;
  message: string;
  receivedAt?: Date;
}

export interface SmsIngestResult {
  outcome: SmsEventOutcome;
  reference: string | null;
  paymentId: Types.ObjectId | null;
  note: string;
}

const normaliseReference = (value: string) => value.trim().toUpperCase();

class SmsVerificationService {
  async ingest(device: PaymentDeviceDoc & { _id: Types.ObjectId }, input: SmsEventInput): Promise<SmsIngestResult> {
    const provider = input.provider.trim().toLowerCase();

    // The device is trusted for particular providers only.
    if (device.allowedProviders.length > 0 && !device.allowedProviders.includes(provider)) {
      return this.reject(device, provider, input, 'This device is not registered to report that provider');
    }
    if (!parserFor(provider)) {
      return this.reject(device, provider, input, 'Unsupported payment provider');
    }
    // A message that did not come from the provider's own sender id is not evidence.
    if (!isKnownSender(provider, input.sender)) {
      return this.reject(device, provider, input, 'The message did not come from a recognised sender');
    }

    const parsed = parserFor(provider)!.parse(input.message);
    if (!parsed) {
      return this.reject(device, provider, input, 'The message is not a recognised payment notification');
    }
    // The money must have landed in a merchant account this device carries.
    const carried = device.merchantAccounts.map(accountKey).filter(Boolean);
    if (carried.length > 0 && parsed.merchantAccount && !carried.includes(accountKey(parsed.merchantAccount))) {
      return this.reject(device, provider, input, 'The message names a merchant account this device does not carry');
    }

    return this.record(device, parsed, input);
  }

  private async reject(
    device: PaymentDeviceDoc & { _id: Types.ObjectId },
    provider: string,
    input: SmsEventInput,
    note: string,
  ): Promise<SmsIngestResult> {
    // Nothing identifying is logged: the reason, never the message.
    logger.warn('Rejected a reported payment SMS', { deviceId: device.deviceId, provider, note });
    return { outcome: 'rejected', reference: null, paymentId: null, note };
  }

  private async record(
    device: PaymentDeviceDoc & { _id: Types.ObjectId },
    parsed: ParsedPaymentSms,
    input: SmsEventInput,
  ): Promise<SmsIngestResult> {
    const reference = normaliseReference(parsed.reference);

    // The duplicate guard is the unique index, not an `if`: two deliveries
    // racing each other cannot both insert.
    let eventId: Types.ObjectId;
    try {
      const event = await PaymentSmsEventModel.create({
        deviceId: device.deviceId,
        provider: parsed.provider,
        smsSender: input.sender.trim().slice(0, 40),
        reference,
        amountMinor: parsed.amountMinor,
        currency: parsed.currency,
        senderPhone: parsed.senderPhone,
        merchantAccount: parsed.merchantAccount,
        occurredAt: parsed.occurredAt,
        receivedAt: input.receivedAt ?? new Date(),
        outcome: 'unmatched',
        rawMessage: input.message.slice(0, 500),
      });
      eventId = event._id as Types.ObjectId;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        const existing = await PaymentSmsEventModel.findOne({ provider: parsed.provider, reference }).select('paymentId').lean();
        return { outcome: 'duplicate', reference, paymentId: existing?.paymentId ?? null, note: 'This transaction was already reported' };
      }
      throw error;
    }

    return this.match(eventId, reference, parsed);
  }

  /** Finds the payment this transaction pays for, and completes it. */
  private async match(eventId: Types.ObjectId, reference: string, parsed: ParsedPaymentSms): Promise<SmsIngestResult> {
    const since = new Date(Date.now() - MATCH_WINDOW_MS);
    const candidate = await PaymentModel.findOne({
      status: PAYMENT_STATUS.PENDING,
      rawReference: reference,
      provider: parsed.provider,
      createdAt: { $gte: since },
    }).lean();

    if (!candidate) {
      await this.close(eventId, 'unmatched', null, 'No pending payment declares this transaction');
      return { outcome: 'unmatched', reference, paymentId: null, note: 'No pending payment declares this transaction' };
    }

    // Every rule must pass. A mismatch is never "close enough".
    const reasons: string[] = [];
    if (parsed.amountMinor < candidate.amountMinor) reasons.push('the amount is less than the payment');
    if (parsed.currency !== candidate.currency) reasons.push('the currency does not match');
    if (candidate.merchantAccount && parsed.merchantAccount && accountKey(candidate.merchantAccount) !== accountKey(parsed.merchantAccount)) {
      reasons.push('the merchant account does not match');
    }
    if (candidate.customerPhone && parsed.senderPhone && accountKey(candidate.customerPhone) !== accountKey(parsed.senderPhone)) {
      reasons.push('the sending number does not match');
    }
    if (candidate.expiresAt && candidate.expiresAt.getTime() < Date.now()) reasons.push('the payment had expired');

    if (reasons.length > 0) {
      const note = `Needs review: ${reasons.join('; ')}`;
      await this.close(eventId, 'unmatched', candidate._id, note);
      // Flagged for a platform admin rather than credited or discarded.
      await PaymentModel.updateOne(
        { _id: candidate._id, status: PAYMENT_STATUS.PENDING },
        { $set: { 'review.required': true, 'review.reason': note, 'review.flaggedAt': new Date() } },
      );
      return { outcome: 'unmatched', reference, paymentId: candidate._id, note };
    }

    // The same path a gateway confirmation takes: it claims the payment
    // atomically and credits the wallet exactly once, keyed by the payment.
    const outcome = await applyProviderReport(
      candidate._id,
      {
        status: 'paid',
        amountMinor: parsed.amountMinor,
        currency: parsed.currency,
        paidAt: parsed.occurredAt ?? new Date(),
      },
      'webhook',
    );
    await PaymentModel.updateOne(
      { _id: candidate._id },
      { $set: { verificationMethod: 'sms_event', verifiedAt: new Date() } },
    );
    await this.close(eventId, 'matched', candidate._id, `Payment ${outcome.outcome}`);
    logger.info('A reported payment SMS verified a payment', { paymentId: String(candidate._id), provider: parsed.provider, outcome: outcome.outcome });
    return { outcome: 'matched', reference, paymentId: candidate._id, note: `Payment ${outcome.outcome}` };
  }

  private async close(eventId: Types.ObjectId, outcome: SmsEventOutcome, paymentId: Types.ObjectId | null, note: string) {
    await PaymentSmsEventModel.updateOne({ _id: eventId }, { $set: { outcome, paymentId, note: note.slice(0, 300) } });
  }

  /** Unmatched and rejected evidence, for the reconciliation screen. */
  async listEvents(input: { outcome?: string; page?: number; limit?: number }) {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const page = Math.max(input.page ?? 1, 1);
    const filter: Record<string, unknown> = {};
    if (input.outcome) filter.outcome = input.outcome;
    const [items, total] = await Promise.all([
      // `rawMessage` is select:false, so it is not returned here.
      PaymentSmsEventModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      PaymentSmsEventModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }
}

export const smsVerificationService = new SmsVerificationService();
export { PAYMENT_PURPOSES };
