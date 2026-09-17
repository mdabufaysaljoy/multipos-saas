import type { Types } from 'mongoose';
import { PRIMARY_FIRST, SubscriptionModel } from '../../models/Subscription';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { ApiError } from '../../utils/ApiError';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { resolvePlanForVertical, verticalOfTenant } from '../../services/subscription/planEntitlements';
import { evaluateTransition } from './transitions';
import { isWithinRenewalWindow } from '../../services/subscription/renewalPolicy';

/**
 * Whether a workspace may move onto a plan - the ONE rule every way of paying
 * follows: a manual transfer request, the wallet, and online checkout.
 *
 *   - the plan must be active and offered to this workspace's POS vertical;
 *   - buying the plan already running is refused, unless it has lapsed (renewal);
 *   - a downgrade is allowed only when current usage fits the target's limits.
 *
 * Kept in one place so a new payment path cannot quietly skip a check.
 */
class PlanChangeService {
  async assertAllowed(tenantId: Types.ObjectId, planId: Types.ObjectId) {
    const plan = await SubscriptionPlanModel.findOne({ _id: planId, isActive: true });
    if (!plan) throw ApiError.notFound('That plan is not available');

    // Resolved for this workspace's vertical: a plan not offered to it cannot
    // be bought, and any downgrade check uses that vertical's limits.
    const resolved = resolvePlanForVertical(plan, await verticalOfTenant(tenantId));
    if (!resolved.isAvailable) throw ApiError.notFound('That plan is not available');

    const current = await SubscriptionModel.findOne({ tenantId }).sort(PRIMARY_FIRST).lean();
    const currentPlan = current
      ? await SubscriptionPlanModel.findOne({ code: current.planSnapshot?.code }).select('tier code name').lean()
      : null;

    // One shared evaluator decides upgrade / cycle-change / downgrade AND
    // whether current usage permits it, so the API and the plan cards can never
    // disagree. Same-plan cycle changes and any upgrade pass straight through; a
    // downgrade only needs cleanup when the workspace exceeds the target limits.
    const rawUsage = await entitlementService.usage(tenantId);
    const verdict = evaluateTransition(
      currentPlan ?? null,
      { code: plan.code, name: plan.name, tier: plan.tier, interval: plan.interval, limits: resolved.limits },
      {
        vertical: rawUsage.vertical,
        branches: rawUsage.stores,
        staff: rawUsage.staff,
        products: rawUsage.products,
        customers: rawUsage.customers,
        storageBytes: rawUsage.storageBytes,
      },
    );

    // Re-buying the plan you are already on is a no-op while it runs, but it is
    // exactly what an expired workspace needs to get back in.
    const standing = await entitlementService.forTenant(tenantId);
    // ...and, in the last days of a running period, the way to keep going: the
    // renewal continues from the period end, so no paid time is lost.
    // ...and during the renewal grace period (overdue, still usable) the way to settle it by hand.
    const isRenewal =
      verdict.kind === 'current' &&
      (!standing.isUsable || Boolean(standing.graceEndsAt) || (current !== null && isWithinRenewalWindow(current.currentPeriodEnd)));

    if (verdict.kind === 'current' && !isRenewal) {
      throw ApiError.badRequest(`You are already on ${plan.name}. It can be renewed in the last 7 days of the period.`);
    }

    // A renewal buys back the exact plan the workspace was already living within,
    // so there is no limit to re-validate.
    if (!isRenewal && !verdict.canProceed) {
      throw ApiError.badRequest(
        `Your workspace exceeds the ${plan.name} limits. Reduce your usage before moving to this plan.`,
        { kind: verdict.kind, targetPlan: plan.code, breaches: verdict.breaches },
      );
    }

    return { plan, resolved, currentPlan, verdict, isRenewal };
  }
}

export const planChangeService = new PlanChangeService();
