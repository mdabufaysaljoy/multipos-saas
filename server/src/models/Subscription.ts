import { Schema, model, type Types } from 'mongoose';
import { SUBSCRIPTION_STATUS } from '../config/constants';
import type { BaseDoc } from './types';
import type { PlanFeatures, PlanLimits } from './SubscriptionPlan';

export interface SubscriptionDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  planId: Types.ObjectId;
  /** Frozen copy of the plan so price changes never rewrite an active period. */
  planSnapshot: {
    code: string;
    name: string;
    interval: string;
    priceMinor: number;
    currency: string;
    features: PlanFeatures;
    limits: PlanLimits;
  };
  status: string;
  startedAt: Date;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  /** When true the subscription runs to the end of the paid period, then stops. */
  cancelAtPeriodEnd: boolean;
  cancelledAt: Date | null;
  autoRenew: boolean;
  provider: string;
  providerSubscriptionId: string | null;
  lastPaymentId: Types.ObjectId | null;
  failedPaymentCount: number;
  /** true when a platform admin activated this by hand. */
  isManual: boolean;
  activatedBy: Types.ObjectId | null;
  notes: string;
}

const subscriptionSchema = new Schema<SubscriptionDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    planId: { type: Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },
    planSnapshot: {
      code: { type: String, required: true },
      name: { type: String, required: true },
      interval: { type: String, required: true },
      priceMinor: { type: Number, required: true },
      currency: { type: String, required: true },
      features: { type: Schema.Types.Mixed, required: true },
      limits: { type: Schema.Types.Mixed, required: true },
    },
    status: { type: String, enum: Object.values(SUBSCRIPTION_STATUS), required: true, index: true },
    startedAt: { type: Date, required: true },
    currentPeriodStart: { type: Date, required: true },
    currentPeriodEnd: { type: Date, required: true, index: true },
    trialEndsAt: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
    autoRenew: { type: Boolean, default: true },
    provider: { type: String, default: 'manual' },
    providerSubscriptionId: { type: String, default: null },
    lastPaymentId: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
    failedPaymentCount: { type: Number, default: 0 },
    isManual: { type: Boolean, default: true },
    activatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    notes: { type: String, default: '' },
  },
  { timestamps: true },
);

subscriptionSchema.index({ tenantId: 1, createdAt: -1 });
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1, autoRenew: 1 });

export const SubscriptionModel = model<SubscriptionDoc>('Subscription', subscriptionSchema);
