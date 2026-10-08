import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * Per-recipient delivery state.
 *
 * `sending` was added when campaign delivery moved to a background worker: it
 * means a worker has CLAIMED this recipient and is attempting it. The claim
 * carries a lease (`claimedUntil`), so a worker that dies mid-batch leaves rows
 * that become claimable again rather than rows stuck for ever.
 *
 * `failed` is told apart by `failureKind`: a transient failure is retried while
 * `attempts` remain, a permanent one never is.
 */
export const SMS_STATUSES = ['queued', 'sending', 'sent', 'failed'] as const;
export type SmsStatus = (typeof SMS_STATUSES)[number];

/** Whether a failure is worth another attempt. */
export const DELIVERY_FAILURE_KINDS = ['transient', 'permanent'] as const;
export type DeliveryFailureKind = (typeof DELIVERY_FAILURE_KINDS)[number];

/** Attempts per recipient before a transient failure is treated as permanent. */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** One row per recipient, so delivery and cost are auditable per message. */
export interface SmsMessageDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId | null;
  campaignId: Types.ObjectId | null;
  customerId: Types.ObjectId | null;
  recipient: string;
  message: string;
  segments: number;
  encoding: string;
  /** 'sms' or 'email' - both share this collection and billing path. */
  channel: string;
  /** What the tenant was charged, in minor units. */
  costMinor: number;
  provider: string;
  providerMessageId: string | null;
  status: SmsStatus;
  error: string | null;
  /** Set only when `status` is 'failed'. */
  failureKind: DeliveryFailureKind | null;
  /** Delivery attempts made for this recipient. Bounds transient retries. */
  attempts: number;
  /** Which bounded batch job owns this recipient. */
  batchIndex: number;
  /** Lease held while a worker is attempting this recipient. */
  claimedUntil: Date | null;
  sentAt: Date | null;
  sentBy: Types.ObjectId | null;
  sentByNameSnapshot: string;
}

const smsSchema = new Schema<SmsMessageDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', default: null },
    campaignId: { type: Schema.Types.ObjectId, ref: 'SmsCampaign', default: null, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    recipient: { type: String, required: true, trim: true },
    message: { type: String, required: true, maxlength: 1600 },
    segments: { type: Number, required: true, min: 1 },
    encoding: { type: String, default: 'GSM7' },
    channel: { type: String, enum: ['sms', 'email'], default: 'sms', index: true },
    costMinor: { type: Number, required: true, min: 0 },
    provider: { type: String, required: true },
    providerMessageId: { type: String, default: null },
    status: { type: String, enum: [...SMS_STATUSES], default: 'queued', index: true },
    error: { type: String, default: null },
    failureKind: { type: String, enum: [...DELIVERY_FAILURE_KINDS, null], default: null },
    attempts: { type: Number, default: 0, min: 0 },
    batchIndex: { type: Number, default: 0, min: 0 },
    claimedUntil: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    sentByNameSnapshot: { type: String, default: '' },
  },
  { timestamps: true },
);

smsSchema.index({ tenantId: 1, createdAt: -1 });

/**
 * One row per recipient per campaign.
 *
 * This is what makes a worker retry safe: a repeated delivery attempt cannot
 * create a second row for the same person, so "has this recipient already been
 * dealt with?" is answerable from the database rather than from a worker's
 * memory. Partial, because a one-off message (`sendOne`) has no campaign and
 * several of those to the same number are perfectly legitimate.
 *
 * NOTE for deployment: Mongoose only builds missing indexes outside production
 * (see `config/db.ts`), so on an existing production database this one must be
 * created deliberately - and any pre-existing duplicate (campaignId, recipient)
 * pair has to be resolved first.
 */
smsSchema.index(
  { campaignId: 1, recipient: 1 },
  { unique: true, partialFilterExpression: { campaignId: { $type: 'objectId' } } },
);

/** The claim query a worker runs: pending work for one batch of one campaign. */
smsSchema.index({ campaignId: 1, batchIndex: 1, status: 1 });

export const SmsMessageModel = model<SmsMessageDoc>('SmsMessage', smsSchema);

/**
 * Campaign lifecycle.
 *
 * `queued` was added when delivery moved to a worker: the campaign is paid for,
 * its recipients are stored, and the work is enqueued but not yet started.
 * `sending` still means a worker is partway through it, and the terminal states
 * are unchanged - a campaign that sent some and failed some is `completed` with
 * a non-zero `failedCount`, exactly as before, which is what the UI already
 * reads.
 *
 *   queued -> sending -> completed        (some or all delivered)
 *                     -> failed           (nothing delivered)
 */
export const SMS_CAMPAIGN_STATUSES = ['draft', 'queued', 'sending', 'completed', 'failed', 'cancelled'] as const;

export interface SmsCampaignDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId | null;
  name: string;
  message: string;
  segments: number;
  encoding: string;
  channel: string;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  /** Debited up front, then partially refunded for anything that failed. */
  estimatedCostMinor: number;
  actualCostMinor: number;
  /** The usage charge that billed this campaign. */
  usageChargeId: Types.ObjectId | null;
  status: string;
  /** Recipients per background batch job. Stored so progress is explainable. */
  batchSize: number;
  batchCount: number;
  queuedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdBy: Types.ObjectId | null;
  createdByNameSnapshot: string;
}

const campaignSchema = new Schema<SmsCampaignDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', default: null },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, maxlength: 1600 },
    segments: { type: Number, required: true, min: 1 },
    encoding: { type: String, default: 'GSM7' },
    channel: { type: String, enum: ['sms', 'email'], default: 'sms', index: true },
    recipientCount: { type: Number, required: true, min: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    estimatedCostMinor: { type: Number, required: true, min: 0 },
    actualCostMinor: { type: Number, default: 0 },
    usageChargeId: { type: Schema.Types.ObjectId, ref: 'UsageCharge', default: null },
    status: { type: String, enum: [...SMS_CAMPAIGN_STATUSES], default: 'draft', index: true },
    batchSize: { type: Number, default: 0, min: 0 },
    batchCount: { type: Number, default: 0, min: 0 },
    queuedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdByNameSnapshot: { type: String, default: '' },
  },
  { timestamps: true },
);

campaignSchema.index({ tenantId: 1, createdAt: -1 });

export const SmsCampaignModel = model<SmsCampaignDoc>('SmsCampaign', campaignSchema);
