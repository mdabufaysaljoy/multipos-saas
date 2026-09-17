import { z } from 'zod';
import { objectId, paginationSchema, phoneNumber } from '../common/common.validators';
import { SMS_STATUSES } from '../../models/SmsMessage';

const phone = phoneNumber;

export const estimateSchema = z.object({
  message: z.string().trim().min(1, 'Enter a message').max(1600),
  // Query strings arrive as text, so this must coerce.
  recipients: z.coerce.number().int().min(1).max(5000).default(1),
});

export const sendOneSchema = z.object({
  to: phone,
  message: z.string().trim().min(1, 'Enter a message').max(1600),
  customerId: objectId.nullable().optional(),
});

/**
 * A bulk campaign targets the workspace's OWN customers, by id.
 *
 * A free-form `phones` array used to be accepted here, which turned the
 * platform into a bulk sender for any 5,000 numbers a tenant cared to paste -
 * spending their own wallet, but burning the platform's sender ID and gateway
 * reputation. Nothing in the product used it. One-off messages to a number that
 * is not yet a customer still go through `POST /messaging/sms`.
 */
export const campaignSchema = z.object({
  name: z.string().trim().min(2, 'Give the campaign a name').max(120),
  message: z.string().trim().min(1, 'Enter a message').max(1600),
  audience: z.enum(['all-customers', 'selected']).default('selected'),
  customerIds: z.array(objectId).max(5000).optional(),
});

export const historySchema = paginationSchema.extend({
  status: z.enum(SMS_STATUSES).optional(),
  campaignId: objectId.optional(),
});

export type EstimateInput = z.infer<typeof estimateSchema>;
export type SendOneInput = z.infer<typeof sendOneSchema>;
export type CampaignInput = z.infer<typeof campaignSchema>;
export type HistoryInput = z.infer<typeof historySchema>;

export const emailCampaignSchema = z.object({
  name: z.string().trim().min(2, 'Give the campaign a name').max(120),
  subject: z.string().trim().min(2, 'Enter a subject').max(200),
  body: z.string().trim().min(1, 'Enter the message').max(20000),
  audience: z.enum(['all-customers', 'selected']).default('selected'),
  customerIds: z.array(objectId).max(5000).optional(),
});

export type EmailCampaignInput = z.infer<typeof emailCampaignSchema>;
