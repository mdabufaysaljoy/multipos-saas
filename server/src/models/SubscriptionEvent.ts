import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export type SubscriptionEventType =
  | 'created'
  | 'activated'
  | 'extended'
  | 'plan_changed'
  | 'renewed'
  | 'renewal_failed'
  | 'cancelled'
  | 'reactivated'
  | 'expired'
  | 'suspended'
  | 'deactivated';

/** Append-only audit trail powering the "subscription history" screen. */
export interface SubscriptionEventDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  subscriptionId: Types.ObjectId;
  type: SubscriptionEventType;
  message: string;
  data: Record<string, unknown>;
  actorId: Types.ObjectId | null;
  actorNameSnapshot: string;
}

const eventSchema = new Schema<SubscriptionEventDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', required: true, index: true },
    type: { type: String, required: true },
    message: { type: String, default: '' },
    data: { type: Schema.Types.Mixed, default: {} },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorNameSnapshot: { type: String, default: 'system' },
  },
  { timestamps: true },
);

eventSchema.index({ tenantId: 1, createdAt: -1 });

export const SubscriptionEventModel = model<SubscriptionEventDoc>('SubscriptionEvent', eventSchema);
