import type { Types } from 'mongoose';
import { PAYMENT_PROVIDERS, PAYMENT_STATUS, SUBSCRIPTION_STATUS } from '../../config/constants';
import { AuditLogModel } from '../../models/AuditLog';
import { PaymentModel, type RefundMethod, type SubscriptionAdjustmentAction } from '../../models/Payment';
import { TenantModel } from '../../models/Tenant';
import { SubscriptionModel } from '../../models/Subscription';
import { SubscriptionEventModel } from '../../models/SubscriptionEvent';
import { ApiError } from '../../utils/ApiError';
import { resolvePage } from '../../utils/pagination';
import type { PaymentProvider, VerifyPaymentResult } from './PaymentProvider';
import { applyProviderReport, resumeActivation } from './paymentConfirmation.service';
import { paymentRegistry } from './registry';

export const PAYMENT_QUEUES = ['review', 'pending', 'failed', 'refunded', 'all'] as const;

const CLOSED_SUBSCRIPTION_STATUSES = [SUBSCRIPTION_STATUS.EXPIRED, SUBSCRIPTION_STATUS.CANCELLED] as const;
export type PaymentQueue = (typeof PAYMENT_QUEUES)[number];

interface Actor {
  id: Types.ObjectId | null;
  name: string;
}

const QUEUE_FILTERS: Record<PaymentQueue, Record<string, unknown>> = {
  review: { 'review.required': true, 'review.resolvedAt': null },
  pending: { status: PAYMENT_STATUS.PENDING },
  failed: { status: { $in: [PAYMENT_STATUS.FAILED, PAYMENT_STATUS.CANCELLED] } },
  refunded: { refundedMinor: { $gt: 0 } },
  all: {},
};

/**
 * The most that may be refunded: what the customer actually paid. For an
 * overpayment that is the provider-confirmed amount, not the plan price.
 */
const refundCapExpression = { $max: ['$amountMinor', { $ifNull: ['$metadata.providerAmountMinor', '$amountMinor'] }] };
const refundCapOf = (payment: { amountMinor: number; metadata?: Record<string, unknown> }) =>
  Math.max(payment.amountMinor, Number.isSafeInteger(payment.metadata?.providerAmountMinor) ? (payment.metadata!.providerAmountMinor as number) : payment.amountMinor);

/**
 * What platform admins can do with a payment. Deliberately narrow:
 *
 *   - re-check a PENDING payment with its provider (the provider decides);
 *   - mark an offline PENDING payment received, through the same amount rules;
 *   - record a refund made outside the system, never beyond what was paid;
 *   - resolve a review with a written explanation.
 *
 * Nothing here can turn a failed, cancelled or refunded payment into a paid one,
 * and nothing edits amounts. Every action is audited by the caller.
 */
class PaymentOperationsService {
  async list(input: { queue: PaymentQueue; provider?: string; tenantId?: Types.ObjectId; page?: number; limit?: number }) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { ...QUEUE_FILTERS[input.queue] };
    if (input.provider) filter.provider = input.provider;
    if (input.tenantId) filter.tenantId = input.tenantId;

    const [items, total] = await Promise.all([
      PaymentModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('tenantId', 'name slug')
        .populate('planId', 'name code')
        .select('-refunds')
        .lean(),
      PaymentModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  async summary() {
    const now = Date.now();
    const [review, pending, stalePending, failedLastDay] = await Promise.all([
      PaymentModel.countDocuments(QUEUE_FILTERS.review),
      PaymentModel.countDocuments(QUEUE_FILTERS.pending),
      PaymentModel.countDocuments({ status: PAYMENT_STATUS.PENDING, createdAt: { $lte: new Date(now - 60 * 60 * 1000) } }),
      PaymentModel.countDocuments({ ...QUEUE_FILTERS.failed, updatedAt: { $gte: new Date(now - 24 * 60 * 60 * 1000) } }),
    ]);
    return { review, pending, stalePending, failedLastDay };
  }

  async detail(id: Types.ObjectId) {
    const payment = await PaymentModel.findById(id)
      .populate('tenantId', 'name slug contactEmail')
      .populate('planId', 'name code priceMinor currency interval')
      .populate('userId', 'name email')
      .lean();
    if (!payment) throw ApiError.notFound('Payment not found');

    const [subscription, events, audit] = await Promise.all([
      payment.subscriptionId
        ? SubscriptionModel.findById(payment.subscriptionId).select('status planSnapshot.name planSnapshot.code currentPeriodStart currentPeriodEnd').lean()
        : null,
      SubscriptionEventModel.find({ 'data.paymentId': String(id) }).sort({ createdAt: -1 }).limit(50).lean(),
      AuditLogModel.find({ 'newValue.paymentId': String(id) }).sort({ createdAt: -1 }).limit(50).select('action actorNameSnapshot newValue createdAt').lean(),
    ]);

    const refundableMinor = refundCapOf(payment);
    const tenantId = (payment.tenantId as unknown as { _id?: Types.ObjectId })?._id ?? (payment.tenantId as unknown as Types.ObjectId);
    // Only the period this payment opened, while it is still the workspace's current one, can be adjusted.
    const subscriptionIsCurrent = Boolean(
      subscription &&
        !CLOSED_SUBSCRIPTION_STATUSES.includes(subscription.status as (typeof CLOSED_SUBSCRIPTION_STATUSES)[number]) &&
        !(await SubscriptionModel.exists({ tenantId, _id: { $gt: subscription._id }, status: { $nin: CLOSED_SUBSCRIPTION_STATUSES } })),
    );
    return {
      payment,
      subscription,
      subscriptionIsCurrent,
      events,
      audit,
      refundableMinor,
      remainingRefundableMinor: Math.max(0, refundableMinor - (payment.refundedMinor ?? 0)),
      provider: this.providerInfo(payment.provider),
    };
  }

  /** Asks the provider again. Only a pending payment can change; a paid one finishes activating. */
  async recheck(id: Types.ObjectId) {
    const payment = await PaymentModel.findById(id).lean();
    if (!payment) throw ApiError.notFound('Payment not found');

    if (payment.status === PAYMENT_STATUS.PAID) {
      await resumeActivation(payment._id);
      return { outcome: 'already_processed' as const, payment: await PaymentModel.findById(id).lean(), tenantId: payment.tenantId };
    }
    if (payment.status !== PAYMENT_STATUS.PENDING) {
      throw ApiError.conflict(`A ${payment.status} payment is final and cannot be re-checked`);
    }
    if (payment.provider === PAYMENT_PROVIDERS.MANUAL) {
      throw ApiError.badRequest('A manual payment has no provider to ask. Mark it received once the money is confirmed.');
    }
    if (!payment.providerTransactionId) throw ApiError.badRequest('This payment was never started with its provider');

    const provider = this.configuredProvider(payment.provider);
    if (!provider) throw ApiError.badRequest(`The ${payment.provider} provider is not configured on this server`);

    let report: VerifyPaymentResult;
    try {
      report = provider.completePayment
        ? await provider.completePayment(payment.providerTransactionId)
        : await provider.verifyPayment(payment.providerTransactionId);
    } catch {
      throw new ApiError('PROVIDER_UNAVAILABLE', `${provider.displayName} could not be reached. Try again shortly.`);
    }

    const result = await applyProviderReport(payment._id, report, 'admin');
    return { outcome: result.outcome, reason: result.reason, payment: result.payment, tenantId: payment.tenantId };
  }

  /**
   * Confirms an OFFLINE payment was received. Gateway payments are refused -
   * their provider is the only authority - and an amount short of the price
   * is refused before anything changes, so a typo cannot fail a real payment.
   */
  async markReceived(id: Types.ObjectId, input: { amountReceivedMinor: number; reference: string; note: string }, actor: Actor) {
    const payment = await PaymentModel.findById(id).lean();
    if (!payment) throw ApiError.notFound('Payment not found');
    if (payment.status !== PAYMENT_STATUS.PENDING) throw ApiError.conflict(`Only a pending payment can be marked received; this one is ${payment.status}`);

    const gateway = payment.provider === PAYMENT_PROVIDERS.MANUAL ? null : this.configuredProvider(payment.provider);
    if (gateway) {
      throw ApiError.conflict(`This payment goes through ${gateway.displayName}. Use Re-check so the provider confirms it.`);
    }
    if (input.amountReceivedMinor < payment.amountMinor) {
      throw ApiError.badRequest('The amount received is less than the price. Nothing was changed.', {
        amountMinor: payment.amountMinor,
        amountReceivedMinor: input.amountReceivedMinor,
      });
    }

    await PaymentModel.updateOne(
      { _id: id, status: PAYMENT_STATUS.PENDING },
      { $set: { providerReference: input.reference, 'metadata.receivedNote': input.note, 'metadata.receivedBy': actor.name } },
    );
    const result = await applyProviderReport(
      payment._id,
      { status: 'paid', amountMinor: input.amountReceivedMinor, currency: payment.currency, paidAt: new Date() },
      'admin',
    );
    return { outcome: result.outcome, payment: result.payment, tenantId: payment.tenantId };
  }

  /**
   * Records money already returned to the customer (in the provider's merchant
   * portal, by transfer, in cash). One atomic update both checks and applies the
   * cap, so concurrent refunds can never add up to more than was paid.
   * A full refund marks the payment refunded; the subscription is left for the
   * admin to change deliberately.
   */
  async recordRefund(
    id: Types.ObjectId,
    input: { amountMinor: number; method: RefundMethod; reference: string; reason: string },
    actor: Actor,
  ) {
    const now = new Date();
    const updated = await PaymentModel.findOneAndUpdate(
      {
        _id: id,
        status: PAYMENT_STATUS.PAID,
        $expr: { $lte: [{ $add: [{ $ifNull: ['$refundedMinor', 0] }, input.amountMinor] }, refundCapExpression] },
      },
      {
        $inc: { refundedMinor: input.amountMinor },
        $push: {
          refunds: {
            amountMinor: input.amountMinor,
            method: input.method,
            reference: input.reference,
            reason: input.reason,
            at: now,
            by: actor.id,
            byNameSnapshot: actor.name,
          },
        },
      },
      { new: true },
    ).lean();

    if (!updated) {
      const payment = await PaymentModel.findById(id).lean();
      if (!payment) throw ApiError.notFound('Payment not found');
      if (payment.status !== PAYMENT_STATUS.PAID) throw ApiError.conflict(`Only a paid payment can be refunded; this one is ${payment.status}`);
      const remaining = Math.max(0, refundCapOf(payment) - (payment.refundedMinor ?? 0));
      throw ApiError.badRequest('That refund is more than what remains refundable', { remainingRefundableMinor: remaining });
    }

    if ((updated.refundedMinor ?? 0) >= refundCapOf(updated)) {
      await PaymentModel.updateOne(
        { _id: id, status: PAYMENT_STATUS.PAID, $expr: { $gte: ['$refundedMinor', refundCapExpression] } },
        { $set: { status: PAYMENT_STATUS.REFUNDED, refundedAt: now } },
      );
    }

    const payment = await PaymentModel.findById(id).lean();
    return { payment: payment!, tenantId: payment!.tenantId };
  }

  async resolveReview(id: Types.ObjectId, note: string, actor: Actor) {
    const resolved = await PaymentModel.findOneAndUpdate(
      { _id: id, 'review.required': true, 'review.resolvedAt': null },
      {
        $set: {
          'review.resolvedAt': new Date(),
          'review.resolvedBy': actor.id,
          'review.resolvedByNameSnapshot': actor.name,
          'review.resolutionNote': note,
        },
      },
      { new: true },
    ).lean();
    if (resolved) return resolved;

    const exists = await PaymentModel.exists({ _id: id });
    if (!exists) throw ApiError.notFound('Payment not found');
    throw ApiError.conflict('This payment is not awaiting review');
  }

  /**
   * After a refund, ends or shortens the subscription period the payment paid for.
   *
   *   - the payment must have been refunded, and must have opened a subscription;
   *   - that subscription must still be running and still be the workspace's
   *     current one (a newer period has already replaced an older one);
   *   - `shorten` moves the end to a moment strictly between now and the paid end;
   *   - at most once per payment, and the subscription only changes if it has not
   *     moved since it was read.
   *
   * Recorded as a subscription event, so the workspace sees what changed and why.
   */
  async adjustSubscriptionAfterRefund(
    id: Types.ObjectId,
    input: { action: SubscriptionAdjustmentAction; until?: Date; reason: string },
    actor: Actor,
  ) {
    const payment = await PaymentModel.findById(id).lean();
    if (!payment) throw ApiError.notFound('Payment not found');
    if ((payment.refundedMinor ?? 0) <= 0) throw ApiError.conflict('Only a refunded payment can change its subscription');
    if (!payment.subscriptionId) throw ApiError.conflict('This payment did not open a subscription');
    if (payment.subscriptionAdjustment) throw ApiError.conflict('The subscription for this payment was already adjusted');

    const subscription = await SubscriptionModel.findById(payment.subscriptionId).lean();
    if (!subscription || CLOSED_SUBSCRIPTION_STATUSES.includes(subscription.status as (typeof CLOSED_SUBSCRIPTION_STATUSES)[number])) {
      throw ApiError.conflict('The subscription this payment paid for is no longer running');
    }
    const newer = await SubscriptionModel.exists({
      tenantId: payment.tenantId,
      _id: { $gt: subscription._id },
      status: { $nin: CLOSED_SUBSCRIPTION_STATUSES },
    });
    if (newer) throw ApiError.conflict('A newer subscription has replaced the one this payment paid for');

    const now = new Date();
    let until: Date;
    if (input.action === 'end_now') {
      until = now;
    } else {
      if (!input.until) throw ApiError.badRequest('Choose the new end date');
      if (input.until <= now) throw ApiError.badRequest('The new end must be in the future; use "end now" to stop access immediately');
      if (input.until >= subscription.currentPeriodEnd) throw ApiError.badRequest('The new end must be before the end of the paid period');
      until = input.until;
    }

    // Claim first: two admins cannot both adjust the same refund.
    const claimed = await PaymentModel.findOneAndUpdate(
      { _id: id, subscriptionAdjustment: null },
      {
        $set: {
          subscriptionAdjustment: {
            action: input.action,
            until,
            previousEnd: subscription.currentPeriodEnd,
            reason: input.reason,
            at: now,
            by: actor.id,
            byNameSnapshot: actor.name,
          },
        },
      },
      { new: true },
    ).lean();
    if (!claimed) throw ApiError.conflict('The subscription for this payment was already adjusted');

    const change =
      input.action === 'end_now'
        ? { status: SUBSCRIPTION_STATUS.EXPIRED, autoRenew: false, currentPeriodEnd: until }
        : { currentPeriodEnd: until };
    const updated = await SubscriptionModel.findOneAndUpdate(
      { _id: subscription._id, status: { $nin: CLOSED_SUBSCRIPTION_STATUSES }, currentPeriodEnd: subscription.currentPeriodEnd },
      { $set: change },
      { new: true },
    ).lean();
    if (!updated) {
      await PaymentModel.updateOne({ _id: id, 'subscriptionAdjustment.at': now }, { $set: { subscriptionAdjustment: null } });
      throw ApiError.conflict('The subscription changed while this was being applied. Reload and try again.');
    }

    // Only move the workspace's pointer if this is still the subscription it points at.
    await TenantModel.updateOne(
      { _id: payment.tenantId, currentSubscriptionId: subscription._id },
      { $set: { subscriptionStatus: updated.status, subscriptionEndsAt: updated.currentPeriodEnd } },
    );

    await SubscriptionEventModel.create({
      tenantId: payment.tenantId,
      subscriptionId: subscription._id,
      type: 'refund_adjusted',
      message:
        input.action === 'end_now'
          ? `Access ended after a refund: ${input.reason}`
          : `Period shortened to ${until.toISOString().slice(0, 10)} after a refund: ${input.reason}`,
      data: { paymentId: String(id), action: input.action, until, previousEnd: subscription.currentPeriodEnd, refundedMinor: payment.refundedMinor },
      actorId: actor.id,
      actorNameSnapshot: actor.name,
    });

    return { payment: claimed, subscription: updated, tenantId: payment.tenantId };
  }

  // ----------------------------------------------------------------------

  private configuredProvider(name: string): PaymentProvider | null {
    try {
      const provider = paymentRegistry.get(name);
      return provider.isConfigured() ? provider : null;
    } catch {
      return null;
    }
  }

  private providerInfo(name: string) {
    const provider = this.configuredProvider(name);
    return { name, configured: Boolean(provider), canRecheck: Boolean(provider) && name !== PAYMENT_PROVIDERS.MANUAL };
  }
}

export const paymentOperationsService = new PaymentOperationsService();
