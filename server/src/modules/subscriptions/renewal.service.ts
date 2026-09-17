import type { Types } from 'mongoose';
import { SUBSCRIPTION_STATUS } from '../../config/constants';
import { PRIMARY_FIRST, SubscriptionModel, type SubscriptionDoc } from '../../models/Subscription';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { ApiError } from '../../utils/ApiError';
import { pricingService } from '../../services/pricing/pricing.service';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { resolvePlanForVertical, verticalOfTenant } from '../../services/subscription/planEntitlements';
import { tryOfferFor } from '../../services/subscription/purchasePricing.service';
import { RENEWAL_GRACE_MS, isWithinRenewalWindow, renewalGraceEndsAt } from '../../services/subscription/renewalPolicy';
import { canRenewAutomatically } from '../../services/subscription/renewalCapability';
import type { TenantContext } from '../../types/express';
import { subscriptionService } from './subscriptions.service';
import { evaluateTransition } from './transitions';
import type { ScheduleChangeInput } from './purchase.validators';

type SubscriptionRecord = SubscriptionDoc & { _id: Types.ObjectId };
/** Who is acting on which workspace: the workspace's own session, or its account owner from the billing page. */
export type RenewalActor = Pick<TenantContext, 'tenantId' | 'userId' | 'userName'>;

const RUNNING = [SUBSCRIPTION_STATUS.TRIAL, SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.CANCELLED] as string[];

/**
 * What happens at the end of the current period, and the owner's controls
 * over it: automatic renewal from the wallet, and a plan change scheduled for
 * the next renewal. Charging is done by `walletRenewal.service`.
 */
class RenewalService {
  private latest(tenantId: Types.ObjectId) {
    return SubscriptionModel.findOne({ tenantId }).sort(PRIMARY_FIRST).lean<SubscriptionRecord>();
  }

  /**
   * A subscription the owner can still set renewal options on: running, or
   * just ended (an entitlement read marks an ended period expired) and not
   * cancelled, within the automatic-renewal grace window.
   */
  private manageable(subscription: SubscriptionRecord, now: Date) {
    if (RUNNING.includes(subscription.status)) return true;
    return (
      subscription.status === SUBSCRIPTION_STATUS.EXPIRED &&
      !subscription.cancelledAt &&
      subscription.currentPeriodEnd.getTime() >= now.getTime() - RENEWAL_GRACE_MS
    );
  }

  async info(tenantId: Types.ObjectId, now = new Date()) {
    const subscription = await this.latest(tenantId);
    if (!subscription) return { subscription: null, renewalWindowOpen: false, nextRenewal: null, scheduledChange: null };

    const vertical = await verticalOfTenant(tenantId);
    const targetId = subscription.scheduledChange?.planId ?? subscription.planId;
    const target = targetId ? await SubscriptionPlanModel.findById(targetId).lean() : null;
    const offer = target ? await tryOfferFor(vertical, target) : null;
    const renewsAutomatically = subscription.autoRenew && !subscription.cancelAtPeriodEnd && canRenewAutomatically(subscription);

    return {
      subscription: {
        id: subscription._id,
        status: subscription.status,
        planCode: subscription.planSnapshot?.code ?? null,
        planName: subscription.planSnapshot?.name ?? null,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        autoRenew: subscription.autoRenew,
        renewWith: subscription.renewWith ?? null,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        failedRenewalAttempts: subscription.failedPaymentCount ?? 0,
        lastRenewalAttemptAt: subscription.lastRenewalAttemptAt ?? null,
        graceEndsAt: renewalGraceEndsAt(subscription, now),
        renewsAutomatically,
        manageable: this.manageable(subscription, now),
      },
      renewalWindowOpen: isWithinRenewalWindow(subscription.currentPeriodEnd, now) || subscription.currentPeriodEnd.getTime() <= now.getTime(),
      nextRenewal: target
        ? {
            planId: target._id,
            code: target.code,
            name: target.name,
            catalogPlanCode: offer?.catalogPlanCode ?? null,
            billingCycle: offer?.billingCycle ?? (target.interval === 'yearly' ? 'annual' : 'monthly'),
            /** The pricing engine's price now; what an automatic renewal would charge today. */
            amountMinor: offer?.listPriceMinor ?? null,
            currency: offer?.currency ?? target.currency,
            available: Boolean(offer && target.isActive),
          }
        : null,
      // A scheduled change is applied by an automatic renewal; with renewal off it only applies if the owner renews.
      scheduledChange: subscription.scheduledChange ? { ...subscription.scheduledChange, appliesAutomatically: renewsAutomatically } : null,
    };
  }

  /** Turns automatic renewal from the account wallet on or off. */
  async setAutoRenew(ctx: RenewalActor, enabled: boolean, now = new Date()) {
    const subscription = await this.latest(ctx.tenantId);
    if (!subscription || !this.manageable(subscription, now)) throw ApiError.notFound('There is no running subscription to renew');
    if (enabled && subscription.cancelAtPeriodEnd) {
      throw ApiError.conflict('This subscription is set to end. Resume it before turning on automatic renewal.');
    }

    await SubscriptionModel.updateOne(
      { _id: subscription._id },
      { $set: enabled ? { autoRenew: true, renewWith: 'wallet', failedPaymentCount: 0, lastRenewalAttemptAt: null } : { autoRenew: false, renewWith: null } },
    );
    await subscriptionService.recordEvent(
      ctx.tenantId,
      subscription._id,
      'auto_renew_changed',
      enabled ? 'Automatic renewal from the wallet turned on' : 'Automatic renewal turned off',
      { id: ctx.userId, name: ctx.userName },
      { enabled },
    );
    return this.info(ctx.tenantId, now);
  }

  /**
   * Schedules the plan the subscription renews into. Nothing changes now: the
   * current plan runs to the end of its period, and the change is applied (and
   * charged, and checked against usage) at renewal. Usage over a downgrade's
   * limits is reported here so the owner can fix it in time.
   */
  async scheduleChange(ctx: RenewalActor, input: ScheduleChangeInput, now = new Date()) {
    const subscription = await this.latest(ctx.tenantId);
    if (!subscription || !this.manageable(subscription, now)) throw ApiError.notFound('There is no running subscription to change');
    if (subscription.cancelAtPeriodEnd) throw ApiError.conflict('This subscription is set to end. Resume it before scheduling a change.');

    const code = await pricingService.legacyCodeFor(input.plan, input.billingCycle);
    if (!code) throw ApiError.notFound('Unknown plan');
    const target = await SubscriptionPlanModel.findOne({ code, isActive: true }).lean();
    if (!target) throw ApiError.conflict('This plan is not available right now', { reason: 'PLAN_UNAVAILABLE' });
    if (target.code === subscription.planSnapshot?.code) throw ApiError.badRequest('That is your current plan');

    const vertical = await verticalOfTenant(ctx.tenantId);
    const resolved = resolvePlanForVertical(target, vertical);
    if (!resolved.isAvailable) throw ApiError.notFound('That plan is not available for this workspace');
    const offer = await tryOfferFor(vertical, target);
    if (!offer) throw ApiError.conflict('This plan cannot be bought at the moment', { reason: 'PRICE_UNAVAILABLE' });

    const currentPlan = await SubscriptionPlanModel.findOne({ code: subscription.planSnapshot?.code }).select('code name tier interval').lean();
    const usage = await entitlementService.usage(ctx.tenantId);
    const verdict = evaluateTransition(
      currentPlan ?? null,
      { code: target.code, name: target.name, tier: target.tier, interval: target.interval, limits: resolved.limits },
      { vertical: usage.vertical, branches: usage.stores, staff: usage.staff, products: usage.products, customers: usage.customers, storageBytes: usage.storageBytes },
    );

    await SubscriptionModel.updateOne(
      { _id: subscription._id },
      {
        $set: {
          scheduledChange: {
            planId: target._id,
            planCode: target.code,
            planName: target.name,
            catalogPlanCode: offer.catalogPlanCode,
            billingCycle: offer.billingCycle,
            requestedAt: now,
            requestedBy: ctx.userId,
            requestedByNameSnapshot: ctx.userName,
          },
        },
      },
    );
    await subscriptionService.recordEvent(
      ctx.tenantId,
      subscription._id,
      'change_scheduled',
      `${target.name} scheduled for the next renewal`,
      { id: ctx.userId, name: ctx.userName },
      { to: target.code, from: subscription.planSnapshot?.code ?? null, kind: verdict.kind },
    );
    return { ...(await this.info(ctx.tenantId, now)), kind: verdict.kind, breaches: verdict.breaches };
  }

  async cancelScheduledChange(ctx: RenewalActor, now = new Date()) {
    const subscription = await this.latest(ctx.tenantId);
    if (!subscription?.scheduledChange) throw ApiError.notFound('No plan change is scheduled');
    await SubscriptionModel.updateOne({ _id: subscription._id }, { $set: { scheduledChange: null } });
    await subscriptionService.recordEvent(
      ctx.tenantId,
      subscription._id,
      'change_cancelled',
      `Scheduled change to ${subscription.scheduledChange.planName} withdrawn`,
      { id: ctx.userId, name: ctx.userName },
      { to: subscription.scheduledChange.planCode },
    );
    return this.info(ctx.tenantId, now);
  }
}

export const renewalService = new RenewalService();
