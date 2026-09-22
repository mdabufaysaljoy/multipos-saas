import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const EMAIL_NOTIFICATION_TYPES = ['subscription_invoice', 'payment_confirmation', 'subscription_expiry_reminder'] as const;
export type EmailNotificationType = (typeof EMAIL_NOTIFICATION_TYPES)[number];
export const EMAIL_NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type EmailNotificationStatus = (typeof EMAIL_NOTIFICATION_STATUSES)[number];

/**
 * One transactional email, identified by what it is ABOUT - never by when it
 * was attempted. The unique `key` (e.g. `invoice:<invoiceId>` or
 * `expiry_3day:<subscriptionId>:<periodEnd>`) is what makes delivery
 * exactly-once: webhook retries, repeated scheduler runs and parallel workers
 * all converge on the same row, and a row that was sent is never sent again.
 *
 * The body is not stored: it is rebuilt from the invoice or subscription on
 * each attempt, so a retry uses the same invoice number and data.
 */
export interface EmailNotificationDoc extends BaseDoc {
  key: string;
  type: EmailNotificationType;
  status: EmailNotificationStatus;
  accountId: Types.ObjectId | null;
  tenantId: Types.ObjectId | null;
  subscriptionId: Types.ObjectId | null;
  paymentId: Types.ObjectId | null;
  invoiceId: Types.ObjectId | null;
  recipient: string;
  subject: string;
  attempts: number;
  lastAttemptAt: Date | null;
  lastError: string;
  sentAt: Date | null;
  /** Lease held by the worker sending it, so two workers never send the same row. */
  claimedUntil: Date | null;
}

const schema = new Schema<EmailNotificationDoc>(
  {
    key: { type: String, required: true, unique: true, maxlength: 200 },
    type: { type: String, enum: [...EMAIL_NOTIFICATION_TYPES], required: true },
    status: { type: String, enum: [...EMAIL_NOTIFICATION_STATUSES], default: 'pending', index: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', default: null },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', default: null },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null },
    recipient: { type: String, default: '', maxlength: 320 },
    subject: { type: String, default: '', maxlength: 200 },
    attempts: { type: Number, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: '', maxlength: 300 },
    sentAt: { type: Date, default: null },
    claimedUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

schema.index({ status: 1, lastAttemptAt: 1 });
schema.index({ invoiceId: 1 }, { partialFilterExpression: { invoiceId: { $type: 'objectId' } } });

export const EmailNotificationModel = model<EmailNotificationDoc>('EmailNotification', schema);
