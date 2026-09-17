import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const SMS_STATUSES = ['queued', 'sent', 'failed'] as const;
export type SmsStatus = (typeof SMS_STATUSES)[number];

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
    sentAt: { type: Date, default: null },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    sentByNameSnapshot: { type: String, default: '' },
  },
  { timestamps: true },
);

smsSchema.index({ tenantId: 1, createdAt: -1 });

export const SmsMessageModel = model<SmsMessageDoc>('SmsMessage', smsSchema);

export const SMS_CAMPAIGN_STATUSES = ['draft', 'sending', 'completed', 'failed', 'cancelled'] as const;

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
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdByNameSnapshot: { type: String, default: '' },
  },
  { timestamps: true },
);

campaignSchema.index({ tenantId: 1, createdAt: -1 });

export const SmsCampaignModel = model<SmsCampaignDoc>('SmsCampaign', campaignSchema);
