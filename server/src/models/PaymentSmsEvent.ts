import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * One payment SMS reported by a registered device.
 *
 * Kept as the evidence behind a verification, and as the duplicate guard: the
 * same message delivered ten times inserts once, because (provider, reference)
 * is unique. Storing the event NEVER moves money; matching does, separately.
 *
 * PRIVACY: only the fields payment matching actually needs are kept. The raw
 * message body is stored `select: false`, is never returned by any account-facing
 * API, and is pruned by TTL - it exists for a platform admin investigating a
 * mismatch, not for browsing customers' messages.
 */
export const SMS_EVENT_OUTCOMES = ['matched', 'unmatched', 'duplicate', 'rejected'] as const;
export type SmsEventOutcome = (typeof SMS_EVENT_OUTCOMES)[number];

export interface PaymentSmsEventDoc extends BaseDoc {
  deviceId: string;
  /** Which mobile-money service the message came from, per its parser. */
  provider: string;
  /** The SMS sender id as received (e.g. "bKash"), for sender validation. */
  smsSender: string;
  /** Normalised transaction reference - the duplicate key. */
  reference: string;
  amountMinor: number;
  currency: string;
  /** The number the money came from, where the message states it. */
  senderPhone: string;
  /** The merchant wallet the money landed in, where the message states it. */
  merchantAccount: string;
  /** When the transaction happened per the message (not when we received it). */
  occurredAt: Date | null;
  receivedAt: Date;
  outcome: SmsEventOutcome;
  /** Why it did not match, for the reconciliation screen. */
  note: string;
  paymentId: Types.ObjectId | null;
  /** Minimised raw text, retained briefly for dispute investigation only. */
  rawMessage: string;
}

const eventSchema = new Schema<PaymentSmsEventDoc>(
  {
    deviceId: { type: String, required: true, index: true },
    provider: { type: String, required: true, index: true },
    smsSender: { type: String, default: '', trim: true, maxlength: 40 },
    reference: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },
    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'BDT', uppercase: true },
    senderPhone: { type: String, default: '', trim: true, maxlength: 40 },
    merchantAccount: { type: String, default: '', trim: true, maxlength: 40 },
    occurredAt: { type: Date, default: null },
    receivedAt: { type: Date, default: () => new Date() },
    outcome: { type: String, enum: [...SMS_EVENT_OUTCOMES], default: 'unmatched', index: true },
    note: { type: String, default: '', maxlength: 300 },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', default: null, index: true },
    rawMessage: { type: String, default: '', maxlength: 500, select: false },
  },
  { timestamps: true },
);

// The duplicate guard: one row per provider transaction, however many times the
// device (or a retrying relay) delivers it.
eventSchema.index({ provider: 1, reference: 1 }, { unique: true });
eventSchema.index({ outcome: 1, createdAt: -1 });
// Evidence is short-lived: 90 days is enough to settle a dispute.
eventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const PaymentSmsEventModel = model<PaymentSmsEventDoc>('PaymentSmsEvent', eventSchema);
