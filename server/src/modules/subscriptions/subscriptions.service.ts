import { Types } from 'mongoose';
import dayjs from 'dayjs';
import { PAYMENT_STATUS, SUBSCRIPTION_STATUS } from '../../config/constants';
import { PaymentModel } from '../../models/Payment';
import { SubscriptionModel } from '../../models/Subscription';
import { SubscriptionEventModel, type SubscriptionEventType } from '../../models/SubscriptionEvent';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { TenantModel } from '../../models/Tenant';
import { ApiError } from '../../utils/ApiError';
import { resolvePage } from '../../utils/pagination';
import { addInterval, buildPlanSnapshot } from '../../services/subscription/provisioning.service';
import { entitlementService } from '../../services/subscription/entitlement.service';
import type {
  AssignSubscriptionInput,
  CancelSubscriptionInput,
  ExtendSubscriptionInput,
  ListSubscriptionsInput,
  SetSubscriptionStatusInput,
} from './subscriptions.validators';

interface Actor {
  id: Types.ObjectId | null;
  name: string;
}

class SubscriptionService {
  /** The tenant-facing view: current plan, usage and remaining days. */
  async current(tenantId: Types.ObjectId) {
    const [subscription, entitlement, usage] = await Promise.all([
      SubscriptionModel.findOne({ tenantId }).sort({ createdAt: -1 }).lean(),
      entitlementService.forTenant(tenantId),
      entitlementService.usage(tenantId),
    ]);
    return { subscription, entitlement, usage };
  }

  async history(tenantId: Types.ObjectId) {
    const [subscriptions, events, payments] = await Promise.all([
      SubscriptionModel.find({ tenantId }).sort({ createdAt: -1 }).lean(),
      SubscriptionEventModel.find({ tenantId }).sort({ createdAt: -1 }).limit(100).lean(),
      PaymentModel.find({ tenantId }).sort({ createdAt: -1 }).limit(50).lean(),
    ]);
    return { subscriptions, events, payments };
  }

  /**
   * Manual activation by a platform administrator. Supersedes any current
   * subscription and records both an event and (optionally) an offline payment.
   */
  async assign(input: AssignSubscriptionInput, actor: Actor) {
    const [tenant, plan] = await Promise.all([
      TenantModel.findById(input.tenantId),
      SubscriptionPlanModel.findById(input.planId),
    ]);
    if (!tenant) throw ApiError.notFound('Tenant not found');
    if (!plan) throw ApiError.notFound('Plan not found');

    const start = input.startDate ?? new Date();
    let end: Date;
    if (input.endDate) {
      end = input.endDate;
    } else {
      const periods = input.periods ?? 1;
      end = start;
      for (let i = 0; i < periods; i += 1) end = addInterval(end, plan.interval);
    }

    if (end <= start) throw ApiError.badRequest('The subscription must end after it starts');

    // Close out whatever is running now so only one subscription is live.
    await SubscriptionModel.updateMany(
      { tenantId: tenant._id, status: { $nin: [SUBSCRIPTION_STATUS.EXPIRED, SUBSCRIPTION_STATUS.CANCELLED] } },
      { $set: { status: SUBSCRIPTION_STATUS.EXPIRED, autoRenew: false } },
    );

    const subscription = await SubscriptionModel.create({
      tenantId: tenant._id,
      planId: plan._id,
      planSnapshot: buildPlanSnapshot(plan),
      status: input.status,
      startedAt: start,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      trialEndsAt: input.status === SUBSCRIPTION_STATUS.TRIAL ? end : null,
      autoRenew: input.autoRenew,
      provider: 'manual',
      isManual: true,
      activatedBy: actor.id,
      notes: input.notes,
    });

    await this.recordEvent(tenant._id, subscription._id, 'activated', `Manually assigned "${plan.name}" until ${dayjs(end).format('D MMM YYYY')}`, actor, {
      planCode: plan.code,
      start,
      end,
    });

    if (input.recordPayment) {
      const payment = await PaymentModel.create({
        tenantId: tenant._id,
        userId: tenant.ownerUserId,
        subscriptionId: subscription._id,
        planId: plan._id,
        amountMinor: input.recordPayment.amountMinor,
        currency: plan.currency,
        provider: input.recordPayment.provider,
        providerReference: input.recordPayment.reference,
        // A platform admin confirming an offline payment is a real, human
        // verification step - not a fabricated gateway success.
        status: PAYMENT_STATUS.PAID,
        paidAt: new Date(),
        metadata: { recordedBy: actor.name, manual: true },
      });
      subscription.lastPaymentId = payment._id;
      await subscription.save();
    }

    await this.syncTenant(tenant._id, subscription._id, input.status, end);
    return subscription.toObject();
  }

  async extend(subscriptionId: Types.ObjectId, input: ExtendSubscriptionInput, actor: Actor) {
    const subscription = await SubscriptionModel.findById(subscriptionId);
    if (!subscription) throw ApiError.notFound('Subscription not found');

    // Extending from today rather than a lapsed end date avoids granting a
    // period that is already in the past.
    const base = subscription.currentPeriodEnd > new Date() ? subscription.currentPeriodEnd : new Date();

    let end = base;
    if (input.until) {
      if (input.until <= base) throw ApiError.badRequest('The new end date must be later than the current one');
      end = input.until;
    } else {
      for (let i = 0; i < (input.periods ?? 1); i += 1) end = addInterval(end, subscription.planSnapshot.interval);
    }

    subscription.currentPeriodEnd = end;
    if (subscription.status === SUBSCRIPTION_STATUS.EXPIRED || subscription.status === SUBSCRIPTION_STATUS.PAST_DUE) {
      subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    }
    if (input.notes) subscription.notes = input.notes;
    await subscription.save();

    await this.recordEvent(subscription.tenantId, subscription._id, 'extended', `Extended until ${dayjs(end).format('D MMM YYYY')}`, actor, { end });
    await this.syncTenant(subscription.tenantId, subscription._id, subscription.status, end);

    return subscription.toObject();
  }

  async setStatus(subscriptionId: Types.ObjectId, input: SetSubscriptionStatusInput, actor: Actor) {
    const subscription = await SubscriptionModel.findById(subscriptionId);
    if (!subscription) throw ApiError.notFound('Subscription not found');

    subscription.status = input.status;
    if (input.status === SUBSCRIPTION_STATUS.CANCELLED) {
      subscription.cancelledAt = new Date();
      subscription.autoRenew = false;
    }
    if (input.status === SUBSCRIPTION_STATUS.SUSPENDED) subscription.autoRenew = false;
    await subscription.save();

    const eventType: SubscriptionEventType =
      input.status === SUBSCRIPTION_STATUS.SUSPENDED
        ? 'suspended'
        : input.status === SUBSCRIPTION_STATUS.CANCELLED
          ? 'cancelled'
          : input.status === SUBSCRIPTION_STATUS.EXPIRED
            ? 'expired'
            : 'activated';

    await this.recordEvent(subscription.tenantId, subscription._id, eventType, input.reason || `Status set to ${input.status}`, actor, {
      status: input.status,
    });
    await this.syncTenant(subscription.tenantId, subscription._id, input.status, subscription.currentPeriodEnd);

    return subscription.toObject();
  }

  /**
   * Customer-initiated cancellation.
   *
   * The default is to stop the next renewal while letting the customer finish
   * the period they already paid for; `immediate` ends access at once.
   */
  async cancel(tenantId: Types.ObjectId, input: CancelSubscriptionInput, actor: Actor) {
    const subscription = await SubscriptionModel.findOne({ tenantId }).sort({ createdAt: -1 });
    if (!subscription) throw ApiError.notFound('No subscription found for this workspace');
    if (subscription.status === SUBSCRIPTION_STATUS.CANCELLED && subscription.cancelAtPeriodEnd) {
      throw ApiError.badRequest('This subscription is already scheduled to end');
    }

    subscription.autoRenew = false;
    subscription.cancelledAt = new Date();

    if (input.immediate) {
      subscription.status = SUBSCRIPTION_STATUS.EXPIRED;
      subscription.cancelAtPeriodEnd = false;
      subscription.currentPeriodEnd = new Date();
    } else {
      subscription.status = SUBSCRIPTION_STATUS.CANCELLED;
      subscription.cancelAtPeriodEnd = true;
    }

    await subscription.save();

    await this.recordEvent(
      tenantId,
      subscription._id,
      'cancelled',
      input.immediate
        ? 'Cancelled immediately at the customer’s request'
        : `Cancelled - access continues until ${dayjs(subscription.currentPeriodEnd).format('D MMM YYYY')}`,
      actor,
      { immediate: input.immediate, reason: input.reason },
    );

    await this.syncTenant(tenantId, subscription._id, subscription.status, subscription.currentPeriodEnd);
    return subscription.toObject();
  }

  /** Undoes a pending cancellation while the period is still running. */
  async reactivate(tenantId: Types.ObjectId, actor: Actor) {
    const subscription = await SubscriptionModel.findOne({ tenantId }).sort({ createdAt: -1 });
    if (!subscription) throw ApiError.notFound('No subscription found for this workspace');
    if (!subscription.cancelAtPeriodEnd) throw ApiError.badRequest('This subscription is not scheduled to end');
    if (subscription.currentPeriodEnd <= new Date()) {
      throw ApiError.badRequest('This period has already ended. Start a new subscription instead.');
    }

    subscription.cancelAtPeriodEnd = false;
    subscription.cancelledAt = null;
    subscription.autoRenew = true;
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    await subscription.save();

    await this.recordEvent(tenantId, subscription._id, 'reactivated', 'Cancellation withdrawn', actor, {});
    await this.syncTenant(tenantId, subscription._id, subscription.status, subscription.currentPeriodEnd);
    return subscription.toObject();
  }

  async listAll(input: ListSubscriptionsInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = {};
    if (input.status) filter.status = input.status;
    if (input.tenantId) filter.tenantId = input.tenantId;

    const [items, total] = await Promise.all([
      SubscriptionModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('tenantId', 'name slug status').lean(),
      SubscriptionModel.countDocuments(filter),
    ]);

    return { items, page, limit, total };
  }

  async recordEvent(
    tenantId: Types.ObjectId,
    subscriptionId: Types.ObjectId,
    type: SubscriptionEventType,
    message: string,
    actor: Actor,
    data: Record<string, unknown>,
  ) {
    await SubscriptionEventModel.create({
      tenantId,
      subscriptionId,
      type,
      message,
      data,
      actorId: actor.id,
      actorNameSnapshot: actor.name,
    });
  }

  /** Keeps the denormalised copy on Tenant in step with the subscription. */
  private async syncTenant(tenantId: Types.ObjectId, subscriptionId: Types.ObjectId, status: string, endsAt: Date) {
    await TenantModel.updateOne(
      { _id: tenantId },
      { $set: { subscriptionStatus: status, currentSubscriptionId: subscriptionId, subscriptionEndsAt: endsAt } },
    );
  }
}

export const subscriptionService = new SubscriptionService();
