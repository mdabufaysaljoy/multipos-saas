import type { Types } from 'mongoose';
import { DEFAULT_POS_VERTICAL } from '../../config/verticals';
import { PRIMARY_FIRST, SubscriptionModel, type SubscriptionDoc } from '../../models/Subscription';
import { TenantModel } from '../../models/Tenant';
import { entitlementService } from './entitlement.service';

type SubscriptionRecord = SubscriptionDoc & { _id: Types.ObjectId };

/** Stored statuses mapped to the names the API uses. The database keeps its existing values. */
const PUBLIC_STATUS: Record<string, string> = {
  trial: 'trialing',
  active: 'active',
  past_due: 'past_due',
  cancelled: 'cancelled',
  expired: 'expired',
  suspended: 'suspended',
};

/**
 * The workspace's subscription record: its primary subscription, or - for a
 * workspace migrated before primaries existed - its most recent one.
 */
function primaryOf(workspaceId: Types.ObjectId) {
  return SubscriptionModel.findOne({ tenantId: workspaceId }).sort(PRIMARY_FIRST).lean<SubscriptionRecord>();
}

/**
 * THE read of a workspace's subscription. Each workspace has its own; nothing
 * here looks at any other workspace of the account.
 *
 * Whether it currently grants access is decided by the entitlement service
 * (lazy expiry, usable statuses) - not re-implemented here - plus the
 * workspace itself not being suspended.
 */
export async function getWorkspaceSubscription(workspaceId: Types.ObjectId) {
  const [subscription, entitlement, workspace] = await Promise.all([
    primaryOf(workspaceId),
    entitlementService.forTenant(workspaceId),
    TenantModel.findById(workspaceId).select('_id name accountId vertical status').lean(),
  ]);

  const workspaceUsable = workspace?.status !== 'suspended';
  const snapshot = subscription?.planSnapshot;
  return {
    workspaceId,
    workspaceName: workspace?.name ?? null,
    accountId: workspace?.accountId ?? null,
    posProductCode: subscription?.posProductCode ?? workspace?.vertical ?? DEFAULT_POS_VERTICAL,
    isActive: Boolean(workspace) && workspaceUsable && entitlement.isUsable,
    daysRemaining: entitlement.daysRemaining,
    subscription: subscription
      ? {
          id: subscription._id,
          accountId: subscription.accountId ?? workspace?.accountId ?? null,
          workspaceId: subscription.tenantId,
          posProductId: subscription.posProductId ?? null,
          posProductCode: subscription.posProductCode ?? snapshot?.vertical ?? workspace?.vertical ?? DEFAULT_POS_VERTICAL,
          planId: subscription.planId,
          planCode: snapshot?.code ?? null,
          planName: snapshot?.name ?? null,
          billingCycle: subscription.billingCycle ?? (snapshot?.interval === 'yearly' ? 'annual' : 'monthly'),
          /** The status in effect now: an elapsed period reads as expired whatever was stored. */
          status: PUBLIC_STATUS[entitlement.status] ?? entitlement.status,
          priceMinor: subscription.priceMinor ?? snapshot?.priceMinor ?? null,
          currency: subscription.currency ?? snapshot?.currency ?? null,
          startAt: subscription.startedAt,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          trialStart: subscription.trialStartAt ?? (subscription.trialEndsAt ? subscription.currentPeriodStart : null),
          trialEnd: subscription.trialEndsAt ?? null,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          autoRenew: subscription.autoRenew,
          createdAt: subscription.createdAt,
          updatedAt: subscription.updatedAt,
        }
      : null,
  };
}

/** Whether this workspace may use its POS right now. */
export async function isSubscriptionActive(workspaceId: Types.ObjectId): Promise<boolean> {
  return (await getWorkspaceSubscription(workspaceId)).isActive;
}

/** Every workspace an account owns, each with its own, independent subscription. */
export async function listAccountSubscriptions(accountId: Types.ObjectId) {
  const workspaces = await TenantModel.find({ accountId }).sort({ createdAt: 1 }).select('_id').lean();
  return Promise.all(workspaces.map((workspace) => getWorkspaceSubscription(workspace._id)));
}
