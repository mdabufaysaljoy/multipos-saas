import { Schema, model, type Types } from 'mongoose';
import { SUBSCRIPTION_STATUS } from '../config/constants';
import type { BaseDoc } from './types';
import type { PlanFeatures, PlanLimits } from './SubscriptionPlan';
import { POS_VERTICALS, type PosVertical } from '../config/verticals';

export const SUBSCRIPTION_BILLING_CYCLES = ['monthly', 'annual'] as const;
export type SubscriptionBillingCycle = (typeof SUBSCRIPTION_BILLING_CYCLES)[number];

/**
 * How "the workspace's subscription" is found: its primary subscription, or -
 * for a workspace whose records predate primaries - its most recent one.
 */
export const PRIMARY_FIRST = { isPrimary: -1, createdAt: -1, _id: -1 } as const;

export interface SubscriptionDoc extends BaseDoc {
  /** The workspace. Each workspace has its own, independent subscription. */
  tenantId: Types.ObjectId;
  /** The account owning the workspace, copied from the workspace on creation - never from a request. */
  accountId: Types.ObjectId | null;
  /** The workspace's POS product (catalog id and stable code). */
  posProductId: Types.ObjectId | null;
  posProductCode: string | null;
  billingCycle: SubscriptionBillingCycle | null;
  /** The price this subscription was sold at, in minor units. Mirrors the frozen plan snapshot. */
  priceMinor: number | null;
  currency: string | null;
  trialStartAt: Date | null;
  /**
   * The ONE subscription that represents the workspace. A unique partial index
   * allows at most one per workspace; older records stay as history.
   */
  isPrimary: boolean;
  planId: Types.ObjectId;
  /** Frozen copy of the plan so price changes never rewrite an active period. */
  planSnapshot: {
    code: string;
    name: string;
    interval: string;
    priceMinor: number;
    currency: string;
    /**
     * The POS vertical `features`/`limits` were resolved for. Absent on
     * snapshots taken before per-vertical plans; those were all Clothing.
     */
    vertical?: PosVertical;
    /** The plan's POS product at purchase time; null for a shared plan or an older snapshot. */
    posProductCode?: string | null;
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
  /** `wallet`: renews automatically from the account wallet at the pricing engine's price. */
  renewWith: 'wallet' | null;
  lastRenewalAttemptAt: Date | null;
  /** When the owner was warned that the wallet cannot cover the coming renewal (once per period). */
  renewalReminderSentAt: Date | null;
  /** A plan to renew into at the next renewal instead of the current one. */
  scheduledChange: {
    planId: Types.ObjectId;
    planCode: string;
    planName: string;
    catalogPlanCode: string | null;
    billingCycle: string;
    requestedAt: Date;
    requestedBy: Types.ObjectId | null;
    requestedByNameSnapshot: string;
  } | null;
  /** true when a platform admin activated this by hand. */
  isManual: boolean;
  activatedBy: Types.ObjectId | null;
  notes: string;
}

const subscriptionSchema = new Schema<SubscriptionDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', default: null },
    posProductId: { type: Schema.Types.ObjectId, ref: 'PosProduct', default: null },
    posProductCode: { type: String, default: null },
    billingCycle: { type: String, enum: [...SUBSCRIPTION_BILLING_CYCLES, null], default: null },
    priceMinor: { type: Number, default: null, min: 0 },
    currency: { type: String, default: null },
    trialStartAt: { type: Date, default: null },
    isPrimary: { type: Boolean, default: false },
    planId: { type: Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },
    planSnapshot: {
      code: { type: String, required: true },
      name: { type: String, required: true },
      interval: { type: String, required: true },
      priceMinor: { type: Number, required: true },
      currency: { type: String, required: true },
      vertical: { type: String, enum: [...POS_VERTICALS] },
      posProductCode: { type: String, default: null },
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
    renewWith: { type: String, enum: ['wallet', null], default: null },
    lastRenewalAttemptAt: { type: Date, default: null },
    renewalReminderSentAt: { type: Date, default: null },
    scheduledChange: {
      type: new Schema(
        {
          planId: { type: Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },
          planCode: { type: String, required: true },
          planName: { type: String, required: true },
          catalogPlanCode: { type: String, default: null },
          billingCycle: { type: String, required: true },
          requestedAt: { type: Date, required: true },
          requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          requestedByNameSnapshot: { type: String, default: '' },
        },
        { _id: false },
      ),
      default: null,
    },
    isManual: { type: Boolean, default: true },
    activatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    notes: { type: String, default: '' },
  },
  { timestamps: true },
);

/**
 * The workspace-level fields are derived, never supplied by a caller: cycle,
 * price and POS type from the frozen plan snapshot, trial start from the
 * period, and the owning account and POS product id from the workspace itself.
 */
subscriptionSchema.pre('validate', function deriveFromSnapshot() {
  const snapshot = this.planSnapshot;
  if (snapshot) {
    this.billingCycle ??= snapshot.interval === 'yearly' ? 'annual' : 'monthly';
    this.priceMinor ??= snapshot.priceMinor;
    this.currency ??= snapshot.currency;
    this.posProductCode ??= snapshot.vertical ?? null;
  }
  if (this.trialEndsAt && !this.trialStartAt) this.trialStartAt = this.currentPeriodStart;
});

subscriptionSchema.pre('save', async function deriveFromWorkspace() {
  if (!this.isNew || (this.accountId && this.posProductId)) return;
  const session = this.$session();
  const workspace = await this.db
    .model('Tenant')
    .findById(this.tenantId)
    .select('accountId vertical')
    .session(session ?? null)
    .lean<{ accountId?: Types.ObjectId | null; vertical?: string }>();
  this.accountId ??= workspace?.accountId ?? null;
  this.posProductCode ??= workspace?.vertical ?? null;
  if (!this.posProductId && this.posProductCode) {
    const product = await this.db
      .model('PosProduct')
      .findOne({ code: this.posProductCode })
      .select('_id')
      .session(session ?? null)
      .lean<{ _id: Types.ObjectId }>();
    this.posProductId = product?._id ?? null;
  }
});

subscriptionSchema.index({ tenantId: 1, createdAt: -1 });
// At most one primary subscription per workspace, enforced by the database.
subscriptionSchema.index({ tenantId: 1 }, { unique: true, partialFilterExpression: { isPrimary: true }, name: 'one_primary_per_workspace' });
subscriptionSchema.index({ accountId: 1, isPrimary: 1 });
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1, autoRenew: 1 });
// Automatic wallet renewals due.
subscriptionSchema.index({ renewWith: 1, autoRenew: 1, currentPeriodEnd: 1 });

export const SubscriptionModel = model<SubscriptionDoc>('Subscription', subscriptionSchema);
