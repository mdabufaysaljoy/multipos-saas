import { Schema, model, type Types } from 'mongoose';
import { PAYMENT_STATUS } from '../config/constants';
import type { BaseDoc } from './types';

export interface PaymentDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  userId: Types.ObjectId | null;
  subscriptionId: Types.ObjectId | null;
  planId: Types.ObjectId | null;
  amountMinor: number;
  currency: string;
  provider: string;
  /** Provider-side identifier (bKash paymentID, Nagad orderId, bank ref...). */
  providerTransactionId: string | null;
  providerReference: string | null;
  status: string;
  failureReason: string | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  /** Guards against double-charging when a webhook is delivered twice. */
  idempotencyKey: string | null;
  metadata: Record<string, unknown>;
}

const paymentSchema = new Schema<PaymentDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', default: null, index: true },
    planId: { type: Schema.Types.ObjectId, ref: 'SubscriptionPlan', default: null },
    amountMinor: { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'amountMinor must be an integer' } },
    currency: { type: String, required: true, uppercase: true },
    provider: { type: String, required: true, index: true },
    providerTransactionId: { type: String, default: null },
    providerReference: { type: String, default: null },
    status: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.PENDING, index: true },
    failureReason: { type: String, default: null },
    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    idempotencyKey: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

paymentSchema.index({ provider: 1, providerTransactionId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
paymentSchema.index({ tenantId: 1, createdAt: -1 });

export const PaymentModel = model<PaymentDoc>('Payment', paymentSchema);
