import { Types } from 'mongoose';
import dayjs from 'dayjs';
import { SUBSCRIPTION_STATUS, USABLE_SUBSCRIPTION_STATUSES, type SubscriptionStatus } from '../../config/constants';
import { PRIMARY_FIRST, SubscriptionModel } from '../../models/Subscription';
import { TenantModel } from '../../models/Tenant';
import { ProductModel } from '../../models/Product';
import { UserModel } from '../../models/User';
import { StoreModel } from '../../models/Store';
import { CustomerModel } from '../../models/Customer';
import { SaleModel } from '../../models/Sale';
import { MenuItemModel } from '../../models/MenuItem';
import { WorkspaceMemberModel } from '../../models/WorkspaceMember';
import { RestaurantOrderModel } from '../../models/RestaurantOrder';
import { SupplierModel } from '../../models/Supplier';
import { StorageObjectModel } from '../../models/StorageObject';
import { SALE_STATUS } from '../../config/constants';
import { DEFAULT_POS_VERTICAL, type PosVertical } from '../../config/verticals';
import { MedicineModel } from '../../models/Medicine';
import { PharmacySaleModel } from '../../models/PharmacySale';
import { ShopProductModel } from '../../models/ShopProduct';
import { ShopSaleModel } from '../../models/ShopSale';
import { isPosVertical, verticalOfTenant } from './planEntitlements';
import { renewalGraceEndsAt } from './renewalPolicy';
import { ROLES } from '../../config/constants';
import type { PlanFeatures, PlanLimits } from '../../models/SubscriptionPlan';
import { ApiError } from '../../utils/ApiError';
import { formatBytes } from '../../utils/formatBytes';

export type FeatureKey = keyof PlanFeatures;
export type LimitKey = keyof PlanLimits;

export interface Entitlement {
  tenantId: Types.ObjectId;
  status: SubscriptionStatus;
  planCode: string | null;
  planName: string | null;
  /** The POS vertical the subscription's entitlements were resolved for. */
  vertical: PosVertical | null;
  interval: string | null;
  features: PlanFeatures;
  limits: PlanLimits;
  currentPeriodEnd: Date | null;
  daysRemaining: number;
  cancelAtPeriodEnd: boolean;
  /** Set while an ended period is still usable because its automatic renewal is being retried. */
  graceEndsAt: Date | null;
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
  smsMarketing: false,
  emailMarketing: false,
  imageOptimization: false,
  loyaltyProgram: false,
  productImport: false,
  supplierManagement: false,
};

const NO_PLAN_LIMITS: PlanLimits = {
  maxStaff: 0,
  maxProducts: 0,
  maxStores: 0,
  maxMonthlySales: 0,
  maxCustomers: 0,
  maxStorageBytes: 0,
  maxSuppliers: 0,
};

/**
 * `planSnapshot` is frozen at purchase time, so a subscription sold before a
 * limit existed has no value for it. Two rules keep that safe:
 *
 *   - a MISSING LIMIT is treated as unlimited (-1). Failing open here is
 *     deliberate: a limit nobody agreed to buy must not retroactively lock an
 *     existing customer out of their own data.
 *   - a MISSING FEATURE is treated as off. Failing closed here is equally
 *     deliberate: a feature nobody paid for must not be given away.
 *
 * Run the plan backfill migration so neither branch is load-bearing in
 * practice; this is the safety net, not the mechanism.
 */
const normalizeLimits = (limits: Partial<PlanLimits> | null | undefined): PlanLimits => ({
  maxStaff: limits?.maxStaff ?? -1,
  maxProducts: limits?.maxProducts ?? -1,
  maxStores: limits?.maxStores ?? -1,
  maxMonthlySales: limits?.maxMonthlySales ?? -1,
  maxCustomers: limits?.maxCustomers ?? -1,
  maxStorageBytes: limits?.maxStorageBytes ?? -1,
  maxSuppliers: limits?.maxSuppliers ?? -1,
});

const normalizeFeatures = (features: Partial<PlanFeatures> | null | undefined): PlanFeatures => ({
  salesReports: features?.salesReports ?? false,
  advancedReports: features?.advancedReports ?? false,
  customerManagement: features?.customerManagement ?? false,
  inventoryLedger: features?.inventoryLedger ?? false,
  multiStore: features?.multiStore ?? false,
  customRoles: features?.customRoles ?? false,
  exportData: features?.exportData ?? false,
  prioritySupport: features?.prioritySupport ?? false,
  smsMarketing: features?.smsMarketing ?? false,
  emailMarketing: features?.emailMarketing ?? false,
  imageOptimization: features?.imageOptimization ?? false,
  loyaltyProgram: features?.loyaltyProgram ?? false,
  // The one feature that defaults to ON when a snapshot predates it: bulk
  // product import is part of every plan, so "missing means off" would lock
  // existing customers out of something nobody ever sold separately. A plan
  // that explicitly stores `false` is still refused.
  productImport: features?.productImport ?? true,
  supplierManagement: features?.supplierManagement ?? false,
});

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
      .sort(PRIMARY_FIRST)
      .lean();

    if (!subscription) {
      return {
        tenantId,
        status: SUBSCRIPTION_STATUS.EXPIRED,
        planCode: null,
        planName: null,
        vertical: null,
        interval: null,
        features: NO_PLAN_FEATURES,
        limits: NO_PLAN_LIMITS,
        currentPeriodEnd: null,
        daysRemaining: 0,
        cancelAtPeriodEnd: false,
        graceEndsAt: null,
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
    // The one exception is the renewal grace period (see `renewalGraceEndsAt`):
    // the period is overdue, not over, while its automatic renewal is retried.
    const graceEndsAt = periodEnd ? renewalGraceEndsAt(subscription, now) : null;
    if (graceEndsAt) {
      if (status !== SUBSCRIPTION_STATUS.PAST_DUE) {
        status = SUBSCRIPTION_STATUS.PAST_DUE;
        await SubscriptionModel.updateOne(
          { _id: subscription._id, status: SUBSCRIPTION_STATUS.ACTIVE },
          { $set: { status: SUBSCRIPTION_STATUS.PAST_DUE } },
        );
        await TenantModel.updateOne({ _id: tenantId, currentSubscriptionId: subscription._id }, { $set: { subscriptionStatus: status } });
      }
    } else if (periodEnd && periodEnd.getTime() <= now.getTime()) {
      if (status !== SUBSCRIPTION_STATUS.SUSPENDED) {
        status = SUBSCRIPTION_STATUS.EXPIRED;
        await SubscriptionModel.updateOne(
          { _id: subscription._id, status: { $ne: SUBSCRIPTION_STATUS.EXPIRED } },
          { $set: { status: SUBSCRIPTION_STATUS.EXPIRED } },
        );
        await TenantModel.updateOne({ _id: tenantId }, { $set: { subscriptionStatus: status } });
      }
    }

    // A subscription with no plan attached grants nothing, whatever its status
    // says: there are no limits or features to honour.
    const hasPlan = Boolean(subscription.planSnapshot?.code);
    const isUsable = hasPlan && USABLE_SUBSCRIPTION_STATUSES.includes(status);

    return {
      tenantId,
      status,
      // `planSnapshot` is a Mixed field, so nothing at the schema level
      // guarantees it is present. A row written by a partial or interrupted
      // write has none, and reading through it threw - which surfaced as a 500
      // on LOGIN, because every session build resolves the entitlement.
      // A malformed subscription must degrade to "no plan", not break sign-in.
      planCode: subscription.planSnapshot?.code ?? null,
      planName: subscription.planSnapshot?.name ?? null,
      // Snapshots from before per-vertical plans were all sold as Clothing.
      vertical: isPosVertical(subscription.planSnapshot?.vertical) ? subscription.planSnapshot.vertical : DEFAULT_POS_VERTICAL,
      interval: subscription.planSnapshot?.interval ?? null,
      features: normalizeFeatures(subscription.planSnapshot?.features),
      limits: normalizeLimits(subscription.planSnapshot?.limits),
      currentPeriodEnd: periodEnd,
      daysRemaining: periodEnd ? Math.max(0, dayjs(periodEnd).diff(dayjs(now), 'day')) : 0,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      graceEndsAt,
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
  assertFeature(
    entitlement: Entitlement,
    feature: FeatureKey,
    label: string,
    /** A feature-specific code lets the client tell this gate apart from a numeric limit. */
    code: ConstructorParameters<typeof ApiError>[0] = 'LIMIT_EXCEEDED',
  ): void {
    if (entitlement.features?.[feature]) return;
    throw new ApiError(code, `${label} is not included in the ${entitlement.planName ?? 'current'} plan.`, {
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

  // ---- individual counters -------------------------------------------------
  // Each `assertCanAdd*` needs exactly one of these. Calling `usage()` for a
  // single check would run six queries to read one number.

  /**
   * The `maxProducts` meter, measured in the vertical's own catalogue: active
   * products for Clothing, menu items for Restaurant. One workspace never counts
   * another vertical's records, and pre-flight checks, downgrade checks and the
   * usage meters all read this same number.
   */
  async countProducts(tenantId: Types.ObjectId, vertical?: PosVertical) {
    const resolved = vertical ?? (await verticalOfTenant(tenantId));
    if (resolved === 'restaurant') return MenuItemModel.countDocuments({ tenantId, deletedAt: null });
    if (resolved === 'pharmacy') return MedicineModel.countDocuments({ tenantId, deletedAt: null });
    if (resolved === 'supershop') return ShopProductModel.countDocuments({ tenantId, deletedAt: null });
    return ProductModel.countDocuments({ tenantId, deletedAt: null, isActive: true });
  }

  /** The owner/admin seat does not consume a staff slot. */
  countStaff(tenantId: Types.ObjectId) {
    return this.countStaffUpTo(tenantId);
  }

  /**
   * Staff seats: active staff whose home is this workspace, plus active members
   * joining from another workspace of the account. With `upTo`, only records at
   * or before that id (both collections share the ObjectId clock), so racing
   * creations get distinct, stable ordinals.
   */
  async countStaffUpTo(tenantId: Types.ObjectId, upTo?: Types.ObjectId) {
    const idBound = upTo ? { _id: { $lte: upTo } } : {};
    const [users, members] = await Promise.all([
      UserModel.countDocuments({ tenantId, role: ROLES.STAFF, deletedAt: null, isActive: true, ...idBound }),
      WorkspaceMemberModel.countDocuments({ tenantId, status: 'active', ...idBound }),
    ]);
    return users + members;
  }

  countStores(tenantId: Types.ObjectId) {
    return StoreModel.countDocuments({ tenantId, isActive: true, deletedAt: null });
  }

  /**
   * Suppliers are workspace-level (not per branch), so the meter is a plain
   * tenant count of live, active records - the same rule the create path and
   * the downgrade view use.
   */
  countSuppliers(tenantId: Types.ObjectId) {
    return SupplierModel.countDocuments({ tenantId, deletedAt: null, isActive: true });
  }

  countCustomers(tenantId: Types.ObjectId) {
    return CustomerModel.countDocuments({ tenantId, deletedAt: null, isActive: true });
  }

  /**
   * Sales recorded so far in the CURRENT calendar month, tenant-wide.
   *
   * Cancelled sales are excluded - a voided mistake is not a transaction the
   * customer should pay for. The window resets on the 1st, so the limit is a
   * monthly allowance rather than a lifetime cap.
   */
  async countMonthlySales(tenantId: Types.ObjectId, vertical?: PosVertical) {
    const monthStart = dayjs().startOf('month').toDate();
    const monthEnd = dayjs().endOf('month').toDate();
    const resolved = vertical ?? (await verticalOfTenant(tenantId));
    if (resolved === 'restaurant') {
      // An order takes its slot when it is opened; a cancelled one gives it back.
      return RestaurantOrderModel.countDocuments({
        tenantId,
        status: { $ne: 'cancelled' },
        createdAt: { $gte: monthStart, $lte: monthEnd },
      });
    }
    if (resolved === 'pharmacy') {
      // A voided pharmacy sale gives its slot back, like a cancelled Clothing sale.
      return PharmacySaleModel.countDocuments({ tenantId, status: 'completed', soldAt: { $gte: monthStart, $lte: monthEnd } });
    }
    if (resolved === 'supershop') {
      return ShopSaleModel.countDocuments({ tenantId, status: 'completed', soldAt: { $gte: monthStart, $lte: monthEnd } });
    }
    return SaleModel.countDocuments({
      tenantId,
      status: SALE_STATUS.COMPLETED,
      soldAt: { $gte: monthStart, $lte: monthEnd },
    });
  }

  /**
   * Bytes held by the workspace, summed from the storage ledger.
   *
   * Summing beats a cached counter here: a counter can drift, and there is no
   * way to reconcile it after the fact. Soft-deleted rows are excluded, so
   * removing a file frees the quota it held.
   */
  async storageBytes(tenantId: Types.ObjectId): Promise<number> {
    const [row] = await StorageObjectModel.aggregate<{ total: number }>([
      { $match: { tenantId, deletedAt: null } },
      { $group: { _id: null, total: { $sum: '$bytes' } } },
    ]);
    return row?.total ?? 0;
  }

  /**
   * Confirms a record that has ALREADY been created did not push the workspace
   * past its limit.
   *
   * The pre-flight `assertCanAdd*` count is not atomic: several requests can
   * pass it at the same instant and every one of them then creates. Verified
   * by test - four concurrent creates put five products on a three-product
   * plan.
   *
   * This asks a different question, after the insert: "how many records exist
   * at or before mine?" ObjectIds are monotonic, so every racing request gets a
   * distinct, stable ordinal. Exactly `max` of them are within the limit; the
   * rest roll their own record back. No shared counter, so nothing can drift.
   */
  assertOrdinalWithinLimit(entitlement: Entitlement, limit: LimitKey, ordinal: number, label: string): void {
    const max = entitlement.limits?.[limit] ?? -1;
    if (max === -1 || ordinal <= max) return;
    throw ApiError.limitExceeded(
      `Your ${entitlement.planName ?? 'current'} plan allows up to ${max} ${label}. Upgrade to add more.`,
      { limit, max, current: max },
    );
  }

  async assertCanAddProduct(tenantId: Types.ObjectId, entitlement: Entitlement, vertical?: PosVertical): Promise<void> {
    this.assertWithinLimit(entitlement, 'maxProducts', await this.countProducts(tenantId, vertical), 'products');
  }

  async assertCanAddStaff(tenantId: Types.ObjectId, entitlement: Entitlement): Promise<void> {
    this.assertWithinLimit(entitlement, 'maxStaff', await this.countStaff(tenantId), 'staff accounts');
  }

  async assertCanAddStore(tenantId: Types.ObjectId, entitlement: Entitlement): Promise<void> {
    this.assertWithinLimit(entitlement, 'maxStores', await this.countStores(tenantId), 'stores');
  }

  async assertCanAddCustomer(tenantId: Types.ObjectId, entitlement: Entitlement): Promise<void> {
    this.assertWithinLimit(entitlement, 'maxCustomers', await this.countCustomers(tenantId), 'customer profiles');
  }

  async assertCanAddSupplier(tenantId: Types.ObjectId, entitlement: Entitlement): Promise<void> {
    this.assertWithinLimit(entitlement, 'maxSuppliers', await this.countSuppliers(tenantId), 'suppliers');
  }

  async assertCanRecordSale(tenantId: Types.ObjectId, entitlement: Entitlement, vertical?: PosVertical): Promise<void> {
    this.assertWithinLimit(
      entitlement,
      'maxMonthlySales',
      await this.countMonthlySales(tenantId, vertical),
      'sales per month',
    );
  }

  /**
   * Bytes held by files created at or before `upTo`.
   *
   * The cumulative equivalent of the ordinal count used for the countable
   * limits. Concurrent uploads each sum only themselves and their predecessors,
   * so the earliest ones that fit are kept and only the genuine overflow rolls
   * back. A plain "is the total over?" check makes every racing upload see the
   * same over-quota total and undo itself, rejecting files that fitted.
   */
  async storageBytesUpTo(tenantId: Types.ObjectId, upTo: Types.ObjectId): Promise<number> {
    const [row] = await StorageObjectModel.aggregate<{ total: number }>([
      { $match: { tenantId, deletedAt: null, _id: { $lte: upTo } } },
      { $group: { _id: null, total: { $sum: '$bytes' } } },
    ]);
    return row?.total ?? 0;
  }

  /**
   * Storage is the one limit measured in a continuous quantity rather than a
   * count, so it needs its own check: the incoming file must FIT, not merely
   * find the workspace below the line.
   */
  async assertCanStore(tenantId: Types.ObjectId, entitlement: Entitlement, incomingBytes: number): Promise<void> {
    const max = entitlement.limits?.maxStorageBytes ?? -1;
    if (max === -1) return;

    const used = await this.storageBytes(tenantId);
    if (used + incomingBytes <= max) return;

    throw ApiError.limitExceeded(
      `Your ${entitlement.planName ?? 'current'} plan includes ${formatBytes(max)} of storage and ${formatBytes(used)} is in use. Upgrade or remove some files.`,
      { limit: 'maxStorageBytes', max, current: used, incomingBytes },
    );
  }

  /**
   * Current usage, counted for plan limits.
   *
   * Only ACTIVE resources count. That is what makes "remove or deactivate N
   * branches" a real remedy for a downgrade - deactivating frees the slot
   * without destroying the record or its history. The same rule applies when
   * checking whether a new resource may be created, so the two directions
   * always agree.
   */
  async usage(tenantId: Types.ObjectId) {
    // Resolved once so both vertical-specific meters agree on what they measure.
    const vertical = await verticalOfTenant(tenantId);
    const [products, staff, stores, customers, monthlySales, storageBytes, suppliers] = await Promise.all([
      this.countProducts(tenantId, vertical),
      this.countStaff(tenantId),
      this.countStores(tenantId),
      this.countCustomers(tenantId),
      this.countMonthlySales(tenantId, vertical),
      this.storageBytes(tenantId),
      this.countSuppliers(tenantId),
    ]);
    return { vertical, products, staff, stores, customers, monthlySales, storageBytes, suppliers };
  }
}

export const entitlementService = new EntitlementService();
