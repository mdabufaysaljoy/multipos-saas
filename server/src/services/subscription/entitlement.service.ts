import { Types } from 'mongoose';
import dayjs from 'dayjs';
import { SUBSCRIPTION_STATUS, USABLE_SUBSCRIPTION_STATUSES, type SubscriptionStatus } from '../../config/constants';
import { SubscriptionModel } from '../../models/Subscription';
import { TenantModel } from '../../models/Tenant';
import { ProductModel } from '../../models/Product';
import { UserModel } from '../../models/User';
import { StoreModel } from '../../models/Store';
import { ROLES } from '../../config/constants';
import type { PlanFeatures, PlanLimits } from '../../models/SubscriptionPlan';
import { ApiError } from '../../utils/ApiError';

export type FeatureKey = keyof PlanFeatures;
export type LimitKey = keyof PlanLimits;

export interface Entitlement {
  tenantId: Types.ObjectId;
  status: SubscriptionStatus;
  planCode: string | null;
  planName: string | null;
  interval: string | null;
  features: PlanFeatures;
  limits: PlanLimits;
  currentPeriodEnd: Date | null;
  daysRemaining: number;
  cancelAtPeriodEnd: boolean;
  /** True when the tenant may read AND write POS data. */
  isUsable: boolean;
  isReadOnly: boolean;
}

const NO_PLAN_FEATURES: PlanFeatures = {
  salesReports: false,
  advancedReports: false,
  customerManagement: false,
  inventoryLedger: false,
  multiStore: false,
  customRoles: false,
  exportData: false,
  prioritySupport: false,
};

const NO_PLAN_LIMITS: PlanLimits = { maxStaff: 0, maxProducts: 0, maxStores: 0, maxMonthlySales: 0 };

/**
 * THE single source of truth for "what is this tenant allowed to do?".
 *
 * Nothing else in the codebase inspects subscription status directly - routes,
 * services and the frontend all funnel through this service, so the rules can
 * change in one place.
 */
class EntitlementService {
  /**
   * Resolves the live entitlement for a tenant, lazily transitioning a lapsed
   * subscription to `expired` so a stale row cannot keep granting access.
   */
  async forTenant(tenantId: Types.ObjectId): Promise<Entitlement> {
    const subscription = await SubscriptionModel.findOne({ tenantId })
      .sort({ createdAt: -1 })
      .lean();

    if (!subscription) {
      return {
        tenantId,
        status: SUBSCRIPTION_STATUS.EXPIRED,
        planCode: null,
        planName: null,
        interval: null,
        features: NO_PLAN_FEATURES,
        limits: NO_PLAN_LIMITS,
        currentPeriodEnd: null,
        daysRemaining: 0,
        cancelAtPeriodEnd: false,
        isUsable: false,
        isReadOnly: true,
      };
    }

    let status = subscription.status as SubscriptionStatus;
    const now = new Date();
    const periodEnd = subscription.currentPeriodEnd;

    // Lazy expiry: a period that has elapsed no longer grants access, whatever
    // the stored status says. The renewal job persists this; here we compute it
    // so a tenant is never let in by a job that has not run yet.
    if (periodEnd && periodEnd.getTime() <= now.getTime()) {
      if (status !== SUBSCRIPTION_STATUS.SUSPENDED) {
        status = SUBSCRIPTION_STATUS.EXPIRED;
        await SubscriptionModel.updateOne(
          { _id: subscription._id, status: { $ne: SUBSCRIPTION_STATUS.EXPIRED } },
          { $set: { status: SUBSCRIPTION_STATUS.EXPIRED } },
        );
        await TenantModel.updateOne({ _id: tenantId }, { $set: { subscriptionStatus: status } });
      }
    }

    const isUsable = USABLE_SUBSCRIPTION_STATUSES.includes(status);

    return {
      tenantId,
      status,
      planCode: subscription.planSnapshot.code,
      planName: subscription.planSnapshot.name,
      interval: subscription.planSnapshot.interval,
      features: subscription.planSnapshot.features ?? NO_PLAN_FEATURES,
      limits: subscription.planSnapshot.limits ?? NO_PLAN_LIMITS,
      currentPeriodEnd: periodEnd,
      daysRemaining: periodEnd ? Math.max(0, dayjs(periodEnd).diff(dayjs(now), 'day')) : 0,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      isUsable,
      isReadOnly: !isUsable,
    };
  }

  /** Throws unless the tenant's subscription currently permits writes. */
  assertUsable(entitlement: Entitlement): void {
    if (entitlement.isUsable) return;
    const reason =
      entitlement.status === SUBSCRIPTION_STATUS.SUSPENDED
        ? 'This workspace has been suspended.'
        : 'Your subscription has expired.';
    throw ApiError.subscriptionInactive(`${reason} Renew your plan to continue using the POS.`, {
      status: entitlement.status,
      currentPeriodEnd: entitlement.currentPeriodEnd,
    });
  }

  /** Throws unless the plan includes the named feature. */
  assertFeature(entitlement: Entitlement, feature: FeatureKey, label: string): void {
    if (entitlement.features?.[feature]) return;
    throw ApiError.limitExceeded(`${label} is not included in the ${entitlement.planName ?? 'current'} plan.`, {
      feature,
      planCode: entitlement.planCode,
    });
  }

  /**
   * Enforces a numeric plan limit. `-1` means unlimited. `current` is the count
   * BEFORE the new record is added.
   */
  assertWithinLimit(entitlement: Entitlement, limit: LimitKey, current: number, label: string): void {
    const max = entitlement.limits?.[limit] ?? 0;
    if (max === -1) return;
    if (current < max) return;
    throw ApiError.limitExceeded(
      `Your ${entitlement.planName ?? 'current'} plan allows up to ${max} ${label}. Upgrade to add more.`,
      { limit, max, current },
    );
  }

  async assertCanAddProduct(tenantId: Types.ObjectId, entitlement: Entitlement): Promise<void> {
    const count = await ProductModel.countDocuments({ tenantId, deletedAt: null });
    this.assertWithinLimit(entitlement, 'maxProducts', count, 'products');
  }

  async assertCanAddStaff(tenantId: Types.ObjectId, entitlement: Entitlement): Promise<void> {
    // The owner/admin seat does not consume a staff slot.
    const count = await UserModel.countDocuments({ tenantId, role: ROLES.STAFF, deletedAt: null });
    this.assertWithinLimit(entitlement, 'maxStaff', count, 'staff accounts');
  }

  async assertCanAddStore(tenantId: Types.ObjectId, entitlement: Entitlement): Promise<void> {
    const count = await StoreModel.countDocuments({ tenantId });
    this.assertWithinLimit(entitlement, 'maxStores', count, 'stores');
  }

  /** Current usage numbers for the subscription screen. */
  async usage(tenantId: Types.ObjectId) {
    const [products, staff, stores] = await Promise.all([
      ProductModel.countDocuments({ tenantId, deletedAt: null }),
      UserModel.countDocuments({ tenantId, role: ROLES.STAFF, deletedAt: null }),
      StoreModel.countDocuments({ tenantId }),
    ]);
    return { products, staff, stores };
  }
}

export const entitlementService = new EntitlementService();
