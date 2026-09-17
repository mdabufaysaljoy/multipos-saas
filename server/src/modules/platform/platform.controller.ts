import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ROLES, SUBSCRIPTION_STATUS } from '../../config/constants';
import { DEFAULT_POS_VERTICAL } from '../../config/verticals';
import { PharmacySaleModel } from '../../models/PharmacySale';
import { ShopSaleModel } from '../../models/ShopSale';
import { PaymentModel } from '../../models/Payment';
import { ProductModel } from '../../models/Product';
import { SaleModel } from '../../models/Sale';
import { RestaurantOrderModel } from '../../models/RestaurantOrder';
import { StoreModel } from '../../models/Store';
import { SubscriptionModel } from '../../models/Subscription';
import { SubscriptionEventModel } from '../../models/SubscriptionEvent';
import { TenantModel } from '../../models/Tenant';
import { UserModel } from '../../models/User';
import { WalletModel } from '../../models/Wallet';
import { UpgradeRequestModel } from '../../models/UpgradeRequest';
import { TopUpRequestModel } from '../../models/TopUpRequest';
import { CouponModel } from '../../models/Coupon';
import { ReturnModel } from '../../models/Return';
import { SmsMessageModel } from '../../models/SmsMessage';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { body, params, query } from '../../middleware/validate';
import { paymentRegistry } from '../../services/payment/registry';
import { recordAudit } from '../../services/audit/audit.service';
import { AuditLogModel } from '../../models/AuditLog';
import { emailService } from '../../services/email';
import { smsRegistry } from '../../services/sms/registry';
import { smsService } from '../../services/sms/sms.service';
import { PlatformSettingsModel, getPlatformSettings } from '../../models/PlatformSettings';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { subscriptionService } from '../subscriptions/subscriptions.service';
import { upgradeService } from '../subscriptions/upgrades.service';
import { topUpService } from '../wallet/wallet.service';
import { couponService } from '../coupons/coupons.service';
import { walletService } from '../../services/wallet/wallet.service';
import type {
  AssignSubscriptionInput,
  ExtendSubscriptionInput,
  ListSubscriptionsInput,
  SetSubscriptionStatusInput,
} from '../subscriptions/subscriptions.validators';

const actorFrom = (req: Request) => ({
  id: req.auth?.id ?? null,
  name: req.auth?.name ?? 'platform admin',
});

/**
 * Platform-wide analytics.
 *
 * MRR is normalised: a yearly plan contributes 1/12 of its price per month, so
 * monthly and annual subscriptions are comparable in one figure.
 */
export const overview = asyncHandler(async (_req: Request, res: Response) => {
  const [tenants, activeTenants, suspended, stores, subscriptions, paidPayments] = await Promise.all([
    TenantModel.countDocuments({}),
    TenantModel.countDocuments({ status: 'active' }),
    TenantModel.countDocuments({ status: 'suspended' }),
    StoreModel.countDocuments({ deletedAt: null }),
    SubscriptionModel.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    PaymentModel.aggregate<{ totalMinor: number; count: number }>([
      { $match: { status: 'paid' } },
      { $group: { _id: null, totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
  ]);

  // Recurring revenue, normalised to a monthly figure.
  const [mrrRow] = await SubscriptionModel.aggregate<{ mrrMinor: number; arrMinor: number }>([
    { $match: { status: { $in: ['active', 'past_due'] } } },
    {
      $group: {
        _id: null,
        mrrMinor: {
          $sum: {
            $cond: [
              { $eq: ['$planSnapshot.interval', 'yearly'] },
              { $divide: ['$planSnapshot.priceMinor', 12] },
              '$planSnapshot.priceMinor',
            ],
          },
        },
        arrMinor: {
          $sum: {
            $cond: [
              { $eq: ['$planSnapshot.interval', 'yearly'] },
              '$planSnapshot.priceMinor',
              { $multiply: ['$planSnapshot.priceMinor', 12] },
            ],
          },
        },
      },
    },
  ]);

  // Trading volume across every tenant - the platform's own health metric.
  const [salesRow] = await SaleModel.aggregate<{ totalMinor: number; orders: number; cogsMinor: number }>([
    { $match: { status: 'completed' } },
    {
      $group: {
        _id: null,
        totalMinor: { $sum: '$totalMinor' },
        orders: { $sum: 1 },
        cogsMinor: {
          $sum: {
            $reduce: {
              input: '$items',
              initialValue: 0,
              in: { $add: ['$$value', { $multiply: ['$$this.costPriceMinorSnapshot', '$$this.quantity'] }] },
            },
          },
        },
      },
    },
  ]);

  // Wallets merged into an account wallet are empty shells kept for history.
  const [walletRow] = await WalletModel.aggregate<{ balanceMinor: number; wallets: number }>([
    { $match: { mergedIntoWalletId: null } },
    { $group: { _id: null, balanceMinor: { $sum: '$balanceMinor' }, wallets: { $sum: 1 } } },
  ]);

  const [pendingUpgrades, pendingTopUps, activeCoupons, branchCount] = await Promise.all([
    UpgradeRequestModel.countDocuments({ status: 'pending' }),
    TopUpRequestModel.countDocuments({ status: 'pending' }),
    CouponModel.countDocuments({ isActive: true }),
    StoreModel.countDocuments({ deletedAt: null }),
  ]);

  ok(res, {
    tenants,
    activeTenants,
    suspendedTenants: suspended,
    stores,
    branches: branchCount,
    subscriptionsByStatus: Object.fromEntries(subscriptions.map((s) => [s._id, s.count])),
    revenue: {
      totalMinor: paidPayments[0]?.totalMinor ?? 0,
      paymentCount: paidPayments[0]?.count ?? 0,
      mrrMinor: Math.round(mrrRow?.mrrMinor ?? 0),
      arrMinor: Math.round(mrrRow?.arrMinor ?? 0),
    },
    // Aggregate trading across every store on the platform.
    marketplace: {
      grossSalesMinor: salesRow?.totalMinor ?? 0,
      orders: salesRow?.orders ?? 0,
      grossProfitMinor: (salesRow?.totalMinor ?? 0) - (salesRow?.cogsMinor ?? 0),
    },
    wallets: { totalBalanceMinor: walletRow?.balanceMinor ?? 0, count: walletRow?.wallets ?? 0 },
    queue: { pendingUpgrades, pendingTopUps },
    activeCoupons,
    paymentProviders: paymentRegistry.listAll(),
  });
});

export const listTenants = asyncHandler(async (req: Request, res: Response) => {
  const input = query<ListSubscriptionsInput & { search?: string }>(req);
  const { page, limit, skip } = resolvePage(input);

  const filter: Record<string, unknown> = {};
  if (input.status) filter.subscriptionStatus = input.status;
  if (input.search) {
    const rx = searchRegex(input.search);
    filter.$or = [{ name: rx }, { slug: rx }, { contactEmail: rx }, { contactPhone: rx }];
  }

  const [tenants, total] = await Promise.all([
    TenantModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    TenantModel.countDocuments(filter),
  ]);

  // Batch the per-tenant counts rather than issuing N queries per row.
  const ids = tenants.map((t) => t._id);
  const [storeCounts, userCounts, saleCounts] = await Promise.all([
    StoreModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { tenantId: { $in: ids } } },
      { $group: { _id: '$tenantId', count: { $sum: 1 } } },
    ]),
    UserModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { tenantId: { $in: ids }, deletedAt: null } },
      { $group: { _id: '$tenantId', count: { $sum: 1 } } },
    ]),
    SaleModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { tenantId: { $in: ids } } },
      { $group: { _id: '$tenantId', count: { $sum: 1 } } },
    ]),
  ]);

  const toMap = (rows: { _id: Types.ObjectId; count: number }[]) => new Map(rows.map((r) => [String(r._id), r.count]));
  const stores = toMap(storeCounts);
  const users = toMap(userCounts);
  const sales = toMap(saleCounts);

  paginated(
    res,
    tenants.map((tenant) => ({
      ...tenant,
      storeCount: stores.get(String(tenant._id)) ?? 0,
      userCount: users.get(String(tenant._id)) ?? 0,
      saleCount: sales.get(String(tenant._id)) ?? 0,
    })),
    buildPageMeta(page, limit, total),
  );
});

export const getTenant = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);

  const tenant = await TenantModel.findById(id).lean();
  if (!tenant) throw ApiError.notFound('Tenant not found');

  const [owner, stores, users, subscriptions, events, payments, entitlement, usage, productCount, saleCount, orderCount] =
    await Promise.all([
      UserModel.findById(tenant.ownerUserId).lean(),
      StoreModel.find({ tenantId: id, deletedAt: null }).lean(),
      UserModel.find({ tenantId: id, deletedAt: null }).select('name email role isActive lastLoginAt').lean(),
      SubscriptionModel.find({ tenantId: id }).sort({ createdAt: -1 }).lean(),
      SubscriptionEventModel.find({ tenantId: id }).sort({ createdAt: -1 }).limit(50).lean(),
      PaymentModel.find({ tenantId: id }).sort({ createdAt: -1 }).limit(50).lean(),
      entitlementService.forTenant(id),
      entitlementService.usage(id),
      ProductModel.countDocuments({ tenantId: id, deletedAt: null }),
      SaleModel.countDocuments({ tenantId: id }),
      RestaurantOrderModel.countDocuments({ tenantId: id }),
    ]);

  // Lifetime totals in the workspace's own vertical: a Restaurant has menu
  // items and orders, never Clothing products and sales.
  const isRestaurant = usage.vertical === 'restaurant';
  // A Pharmacy has medicines and pharmacy sales.
  const isPharmacy = usage.vertical === 'pharmacy';
  const pharmacySaleCount = isPharmacy ? await PharmacySaleModel.countDocuments({ tenantId: id }) : 0;
  // A Supershop has shop products and shop sales.
  const isSupershop = usage.vertical === 'supershop';
  const shopSaleCount = isSupershop ? await ShopSaleModel.countDocuments({ tenantId: id }) : 0;

  ok(res, {
    tenant,
    owner: owner ? { id: owner._id, name: owner.name, email: owner.email, phone: owner.phone } : null,
    stores,
    users,
    subscriptions,
    events,
    payments,
    entitlement,
    usage: {
      ...usage,
      products: isRestaurant || isPharmacy || isSupershop ? usage.products : productCount,
      sales: isRestaurant ? orderCount : isPharmacy ? pharmacySaleCount : isSupershop ? shopSaleCount : saleCount,
    },
  });
});

/** Suspending a tenant blocks every request from that workspace immediately. */
export const setTenantStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<{ status: 'active' | 'suspended'; reason?: string }>(req);

  const tenant = await TenantModel.findByIdAndUpdate(
    id,
    {
      $set: {
        status: input.status,
        suspendedAt: input.status === 'suspended' ? new Date() : null,
        suspendedReason: input.status === 'suspended' ? input.reason ?? '' : null,
      },
    },
    { new: true },
  ).lean();

  if (!tenant) throw ApiError.notFound('Tenant not found');

  await recordAudit(req, {
    action: 'tenant.status_changed',
    targetTenantId: tenant._id,
    targetLabel: tenant.name,
    newValue: { status: input.status, reason: input.reason },
  });

  ok(res, tenant);
});

export const assignSubscription = asyncHandler(async (req: Request, res: Response) => {
  created(res, await subscriptionService.assign(body<AssignSubscriptionInput>(req), actorFrom(req)));
});

export const extendSubscription = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await subscriptionService.extend(id, body<ExtendSubscriptionInput>(req), actorFrom(req)));
});

export const setSubscriptionStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await subscriptionService.setStatus(id, body<SetSubscriptionStatusInput>(req), actorFrom(req)));
});

export const listSubscriptions = asyncHandler(async (req: Request, res: Response) => {
  const result = await subscriptionService.listAll(query<ListSubscriptionsInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

/** Tenants whose access is about to lapse - the platform's follow-up list. */
export const expiringSoon = asyncHandler(async (_req: Request, res: Response) => {
  const horizon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const items = await SubscriptionModel.find({
    status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIAL, SUBSCRIPTION_STATUS.PAST_DUE] },
    currentPeriodEnd: { $lte: horizon },
  })
    .sort({ currentPeriodEnd: 1 })
    .limit(100)
    .populate('tenantId', 'name slug contactEmail contactPhone status')
    .lean();

  ok(res, items);
});

/** Directory of every workspace owner and staff account across the platform. */
export const listCustomers = asyncHandler(async (req: Request, res: Response) => {
  const input = query<ListSubscriptionsInput & { search?: string }>(req);
  const { page, limit, skip } = resolvePage(input);

  const filter: Record<string, unknown> = { role: { $in: [ROLES.ADMIN, ROLES.STAFF] }, deletedAt: null };
  if (input.tenantId) filter.tenantId = input.tenantId;
  if (input.search) {
    const rx = searchRegex(input.search);
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }

  const [items, total] = await Promise.all([
    UserModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('name email phone role isActive lastLoginAt createdAt tenantId')
      .populate('tenantId', 'name slug status subscriptionStatus')
      .lean(),
    UserModel.countDocuments(filter),
  ]);

  paginated(res, items, buildPageMeta(page, limit, total));
});

/** Upgrade requests awaiting a decision. */
export const listUpgradeRequests = asyncHandler(async (req: Request, res: Response) => {
  const input = query<ListSubscriptionsInput & { status?: string }>(req);
  const result = await upgradeService.listAll(input);
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const approveUpgrade = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const { reviewNote } = body<{ reviewNote?: string }>(req);
  const result = await upgradeService.approve(id, actorFrom(req), reviewNote ?? '');
  await recordAudit(req, {
    action: 'subscription.upgrade_approved',
    targetTenantId: result.request.tenantId,
    targetLabel: result.request.planSnapshot.name,
    oldValue: { plan: result.request.currentPlanCodeSnapshot },
    newValue: { plan: result.request.planSnapshot.code, amountMinor: result.request.amountMinor },
  });
  created(res, result);
});

export const rejectUpgrade = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const { reviewNote } = body<{ reviewNote?: string }>(req);
  ok(res, await upgradeService.reject(id, actorFrom(req), reviewNote ?? ''));
});

export const getSettings = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await getPlatformSettings());
});

export const updateSettings = asyncHandler(async (req: Request, res: Response) => {
  const input = body<Record<string, unknown>>(req);

  // An empty SMTP password means "leave it alone", not "clear it" - otherwise
  // re-saving the form from the UI would silently break email.
  const smtp = input.smtp as Record<string, unknown> | undefined;
  if (smtp && (smtp.password === '' || smtp.password === undefined)) delete smtp.password;

  // Same rule for the SMS gateway key: an empty box means "leave it alone",
  // not "delete my credentials".
  const sms = input.sms as Record<string, unknown> | undefined;
  if (sms && (sms.apiKey === '' || sms.apiKey === undefined)) delete sms.apiKey;

  // Credential blocks MUST be written as dot-paths. `$set: { smtp: {...} }`
  // replaces the whole subdocument, so omitting the password to keep it would
  // instead delete it - the exact opposite of what the rule above intends.
  // Verified by test: saving the form with a blank key wiped the stored one.
  const flattened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if ((key === 'smtp' || key === 'sms') && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
        flattened[`${key}.${field}`] = fieldValue;
      }
    } else {
      flattened[key] = value;
    }
  }

  const updated = await PlatformSettingsModel.findOneAndUpdate(
    { key: 'platform' },
    { $set: flattened },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  // Reload in-process so the new credentials are live immediately rather than
  // at the next restart.
  if (sms) await smsRegistry.refresh();

  await recordAudit(req, {
    action: 'platform.settings_updated',
    // Field NAMES only. Logging the values would put a gateway key in the audit
    // trail, which is exactly where a secret must never be.
    newValue: { keys: Object.keys(input), smsKeyRotated: Boolean(sms && 'apiKey' in sms) },
  });
  ok(res, updated);
});

// ------------------------------------------------------------ wallet admin

export const listTopUps = asyncHandler(async (req: Request, res: Response) => {
  const result = await topUpService.listAll(query<ListSubscriptionsInput & { status?: string }>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const approveTopUp = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const { reviewNote } = body<{ reviewNote?: string }>(req);
  const result = await topUpService.approve(id, actorFrom(req), reviewNote ?? '');
  await recordAudit(req, {
    action: 'wallet.topup_approved',
    targetTenantId: result.request.tenantId,
    targetLabel: result.request.transactionId,
    newValue: { amountMinor: result.request.amountMinor, balanceMinor: result.balanceMinor },
  });
  ok(res, result);
});

export const rejectTopUp = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const { reviewNote } = body<{ reviewNote?: string }>(req);
  ok(res, await topUpService.reject(id, actorFrom(req), reviewNote ?? ''));
});

/** Manual credit/debit against a tenant's wallet, always reason-stamped. */
export const adjustWallet = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<import('../wallet/wallet.validators').ManualAdjustmentInput>(req);
  const result = await topUpService.adjust(id, input, actorFrom(req));
  await recordAudit(req, {
    action: 'wallet.manual_adjustment',
    targetTenantId: id,
    newValue: { direction: input.direction, amountMinor: input.amountMinor, reason: input.reason },
  });
  ok(res, result);
});

export const tenantWallet = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const [wallet, transactions] = await Promise.all([
    walletService.balance(id),
    walletService.transactions(id, { limit: 50 }),
  ]);
  ok(res, { wallet, transactions: transactions.items });
});

// ----------------------------------------------------------------- coupons

export const listCoupons = asyncHandler(async (req: Request, res: Response) => {
  const result = await couponService.list(query<{ page?: number; limit?: number }>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const createCoupon = asyncHandler(async (req: Request, res: Response) => {
  created(res, await couponService.create(body<Record<string, unknown>>(req), req.auth?.id ?? null));
});

export const updateCoupon = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await couponService.update(id, body<Record<string, unknown>>(req)));
});

// ------------------------------------------------------------- audit log

export const auditLog = asyncHandler(async (req: Request, res: Response) => {
  const input = query<ListSubscriptionsInput & { action?: string }>(req);
  const { page, limit, skip } = resolvePage(input);

  const filter: Record<string, unknown> = {};
  if (input.tenantId) filter.targetTenantId = input.tenantId;
  if (input.action) filter.action = input.action;

  const [items, total] = await Promise.all([
    AuditLogModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('targetTenantId', 'name').lean(),
    AuditLogModel.countDocuments(filter),
  ]);

  paginated(res, items, buildPageMeta(page, limit, total));
});

// -------------------------------------------------- integration settings

/** Provider status WITHOUT leaking credentials. */
export const integrations = asyncHandler(async (_req: Request, res: Response) => {
  const { getPlatformSettings } = await import('../../models/PlatformSettings');
  const settings = await getPlatformSettings();

  ok(res, {
    sms: {
      ...(await smsService.statusAsync()),
      costMinor: settings.smsCostMinor,
      // Credentials are never returned; only the shape and whether a key is set.
      config: {
        provider: settings.sms?.provider ?? 'alpha',
        baseUrl: settings.sms?.baseUrl ?? 'https://api.sms.net.bd',
        senderId: settings.sms?.senderId ?? '',
        enabled: settings.sms?.enabled ?? false,
        apiKeySet: Boolean(await hasSmsApiKey()),
      },
      balance: await smsService.providerBalance(),
    },
    email: {
      ...(await emailService.statusAsync()),
      costMinor: settings.emailCostMinor,
      // Credentials are never returned; only the non-secret shape is echoed.
      smtp: {
        host: settings.smtp?.host ?? '',
        port: settings.smtp?.port ?? 587,
        secure: settings.smtp?.secure ?? false,
        username: settings.smtp?.username ?? '',
        fromName: settings.smtp?.fromName ?? '',
        fromEmail: settings.smtp?.fromEmail ?? '',
        enabled: settings.smtp?.enabled ?? false,
        passwordSet: Boolean(settings.smtp?.host),
      },
    },
  });
});

/** Verifies SMTP credentials without sending anything to a customer. */
/**
 * Verifies the stored SMS credentials against the live gateway.
 *
 * Reads the account balance rather than sending a message: it proves the key
 * works without spending money or messaging a real person.
 */
export const testSms = asyncHandler(async (req: Request, res: Response) => {
  const status = await smsService.statusAsync();
  if (!status.available) {
    await recordAudit(req, { action: 'platform.sms_tested', newValue: { ok: false, reason: 'not configured' } });
    ok(res, { ok: false, message: 'No SMS gateway is configured, or it is switched off.' });
    return;
  }

  const balance = await smsService.providerBalance();
  const okResult = balance.error === undefined && balance.balanceMinor !== null;

  await recordAudit(req, { action: 'platform.sms_tested', newValue: { ok: okResult, provider: status.provider } });
  ok(res, {
    ok: okResult,
    provider: status.displayName,
    balanceMinor: balance.balanceMinor,
    currency: balance.currency,
    message: okResult
      ? 'The gateway accepted these credentials.'
      : balance.error ?? 'The gateway rejected these credentials.',
  });
});

/** True when a gateway key is stored. Never returns the key itself. */
async function hasSmsApiKey(): Promise<boolean> {
  const doc = await PlatformSettingsModel.findOne({ key: 'platform' }).select('+sms.apiKey').lean();
  return Boolean(doc?.sms?.apiKey);
}

export const testSmtp = asyncHandler(async (req: Request, res: Response) => {
  const result = await emailService.verify();
  await recordAudit(req, { action: 'platform.smtp_tested', newValue: { ok: result.ok } });
  ok(res, result);
});

// ------------------------------------------------- workspace provisioning

/**
 * Creates a whole workspace on a customer's behalf - the backbone of the
 * one-time setup service.
 *
 * Accepts either an existing user id as owner, or the details to create one.
 * Everything a normal signup produces (tenant, admin, system roles, store) is
 * created through the SAME code paths, so a platform-provisioned workspace is
 * indistinguishable from a self-service one.
 */
export const createWorkspace = asyncHandler(async (req: Request, res: Response) => {
  const input = body<{
    businessName: string;
    ownerUserId?: string;
    owner?: { name: string; email: string; phone?: string; password: string };
    planId?: string;
    periods?: number;
    storeName?: string;
    storeCode?: string;
  }>(req);

  const { UserModel: Users, hashPassword } = await import('../../models/User');
  const { createSystemRoles } = await import('../roles/roles.defaults');
  const { startTrialSubscription } = await import('../../services/subscription/provisioning.service');

  const tenantId = new Types.ObjectId();
  let ownerId: Types.ObjectId;

  if (input.ownerUserId) {
    const existing = await Users.findById(input.ownerUserId);
    if (!existing) throw ApiError.badRequest('The selected owner does not exist');
    if (existing.tenantId) {
      // The OWNER of a platform account may own another workspace: it joins
      // their existing account and they switch into it. Their user record and
      // home workspace are left exactly as they are. Staff, and administrators
      // of a workspace they do not own, are refused.
      const { AccountModel } = await import('../../models/Account');
      const ownsAccount = existing.role === ROLES.ADMIN && Boolean(await AccountModel.exists({ ownerUserId: existing._id }));
      if (!ownsAccount) throw ApiError.badRequest('That user already belongs to a workspace they do not own');
      ownerId = existing._id;
    } else {
      ownerId = existing._id;
      existing.tenantId = tenantId;
      existing.role = ROLES.ADMIN;
      await existing.save();
    }
  } else {
    if (!input.owner) throw ApiError.badRequest('Provide an existing owner or the details to create one');
    const clash = await Users.findOne({ email: input.owner.email, deletedAt: null }).select('_id').lean();
    if (clash) throw ApiError.conflict('A user with that email already exists');

    const createdOwner = await Users.create({
      tenantId,
      name: input.owner.name,
      email: input.owner.email,
      phone: input.owner.phone ?? '',
      passwordHash: await hashPassword(input.owner.password),
      role: ROLES.ADMIN,
      isActive: true,
    });
    ownerId = createdOwner._id;
  }

  const { uniqueSlug, codeFromName } = await import('../../utils/slug');
  const { ensureAccountForOwner } = await import('../../services/account/account.service');

  // The owner's existing account is reused, so an owner who already runs a
  // workspace gets this one under the same account.
  const accountId = await ensureAccountForOwner(ownerId, {
    name: input.businessName,
    contactEmail: input.owner?.email ?? '',
  });

  await TenantModel.create({
    _id: tenantId,
    accountId,
    vertical: DEFAULT_POS_VERTICAL,
    name: input.businessName,
    slug: uniqueSlug(input.businessName),
    ownerUserId: ownerId,
    status: 'active',
    contactEmail: input.owner?.email ?? '',
    contactPhone: input.owner?.phone ?? '',
  });

  await createSystemRoles(tenantId);

  // Either the requested plan, or the standard trial.
  if (input.planId) {
    await subscriptionService.assign(
      {
        tenantId,
        planId: new Types.ObjectId(input.planId),
        periods: input.periods ?? 1,
        status: 'active',
        autoRenew: false,
        notes: 'Provisioned by platform admin',
      } as never,
      actorFrom(req),
    );
  } else {
    const trialId = await startTrialSubscription(tenantId);
    if (trialId) {
      const { AccountModel } = await import('../../models/Account');
      await AccountModel.updateOne({ _id: accountId }, { $set: { trialUsedAt: new Date() } });
    }
  }

  const store = await StoreModel.create({
    tenantId,
    name: input.storeName ?? `${input.businessName} - Main`,
    code: (input.storeCode ?? codeFromName(input.businessName)).toUpperCase(),
    currency: 'BDT',
    isDefault: true,
    isActive: true,
  });

  await Users.updateOne({ _id: ownerId }, { $set: { storeId: store._id } });

  await recordAudit(req, {
    action: 'CREATE_WORKSPACE',
    targetTenantId: tenantId,
    targetStoreId: store._id,
    targetUserId: ownerId,
    targetLabel: input.businessName,
    newValue: { planId: input.planId ?? 'trial' },
  });

  created(res, { tenantId, ownerId, storeId: store._id, name: input.businessName });
});

/** Users without a workspace - candidates to own a new one. */
export const unassignedUsers = asyncHandler(async (_req: Request, res: Response) => {
  const users = await UserModel.find({ tenantId: null, role: { $ne: ROLES.PLATFORM_ADMIN }, deletedAt: null })
    .select('name email phone createdAt')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  ok(res, users);
});

/** Platform-level user administration. */
export const updateUser = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<{ name?: string; phone?: string; isActive?: boolean }>(req);

  const user = await UserModel.findById(id);
  if (!user) throw ApiError.notFound('User not found');
  if (user.role === ROLES.PLATFORM_ADMIN && input.isActive === false) {
    throw ApiError.badRequest('A platform administrator cannot be suspended from here');
  }

  const before = { name: user.name, isActive: user.isActive };
  if (input.name !== undefined) user.name = input.name;
  if (input.phone !== undefined) user.phone = input.phone;
  if (input.isActive !== undefined) {
    user.isActive = input.isActive;
    user.permissionVersion += 1;
  }
  await user.save();

  if (input.isActive === false) {
    const { RefreshTokenModel } = await import('../../models/RefreshToken');
    await RefreshTokenModel.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  }

  await recordAudit(req, {
    action: 'UPDATE_USER',
    targetTenantId: user.tenantId,
    targetUserId: user._id,
    targetLabel: user.email,
    oldValue: before,
    newValue: { name: user.name, isActive: user.isActive },
  });

  ok(res, { id: user._id, name: user.name, email: user.email, isActive: user.isActive });
});

// ------------------------------------------------------- global analytics

/**
 * Platform-wide analytics with a date range.
 *
 * Everything is aggregated in MongoDB - no dataset is shipped to the browser
 * to be summed. Profit uses the cost snapshotted on each sale line, so
 * historical figures never shift when a product is re-priced today.
 */
export const analytics = asyncHandler(async (req: Request, res: Response) => {
  const input = query<{ preset?: string; from?: Date; to?: Date }>(req);
  const { resolveRange } = await import('../reports/reports.service');
  const range = resolveRange({ preset: (input.preset ?? 'last30') as never, from: input.from, to: input.to } as never);

  const inRange = { $gte: range.from, $lte: range.to };

  const [
    userRows,
    tenantRows,
    subsRows,
    planRows,
    paymentRows,
    topUpRows,
    salesRow,
    returnRow,
    smsRow,
    newUsers,
    newTenants,
    requestRows,
  ] = await Promise.all([
    UserModel.aggregate<{ _id: boolean; count: number }>([
      { $match: { deletedAt: null } },
      { $group: { _id: '$isActive', count: { $sum: 1 } } },
    ]),
    TenantModel.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    SubscriptionModel.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    SubscriptionModel.aggregate<{ _id: { code: string; interval: string }; count: number }>([
      { $match: { status: { $in: ['active', 'trial', 'past_due'] } } },
      { $group: { _id: { code: '$planSnapshot.code', interval: '$planSnapshot.interval' }, count: { $sum: 1 } } },
    ]),
    PaymentModel.aggregate<{ _id: string; totalMinor: number; count: number }>([
      { $match: { status: 'paid', paidAt: inRange } },
      { $group: { _id: '$provider', totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
    TopUpRequestModel.aggregate<{ _id: string; totalMinor: number; count: number }>([
      { $match: { createdAt: inRange } },
      { $group: { _id: '$status', totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
    SaleModel.aggregate<{ grossMinor: number; orders: number; items: number; discountMinor: number; cogsMinor: number }>([
      { $match: { status: 'completed', soldAt: inRange } },
      {
        $group: {
          _id: null,
          grossMinor: { $sum: '$totalMinor' },
          orders: { $sum: 1 },
          items: { $sum: { $sum: '$items.quantity' } },
          discountMinor: { $sum: '$discountMinor' },
          cogsMinor: {
            $sum: {
              $reduce: {
                input: '$items',
                initialValue: 0,
                in: { $add: ['$$value', { $multiply: ['$$this.costPriceMinorSnapshot', '$$this.quantity'] }] },
              },
            },
          },
        },
      },
    ]),
    ReturnModel.aggregate<{ amountMinor: number; count: number }>([
      { $match: { returnedAt: inRange } },
      { $group: { _id: null, amountMinor: { $sum: '$totalMinor' }, count: { $sum: 1 } } },
    ]),
    SmsMessageModel.aggregate<{ _id: string; count: number; costMinor: number }>([
      { $match: { createdAt: inRange, status: 'sent' } },
      { $group: { _id: '$channel', count: { $sum: 1 }, costMinor: { $sum: '$costMinor' } } },
    ]),
    UserModel.countDocuments({ createdAt: inRange, deletedAt: null }),
    TenantModel.countDocuments({ createdAt: inRange }),
    UpgradeRequestModel.aggregate<{ _id: { status: string; kind: string }; count: number }>([
      { $match: { createdAt: inRange } },
      { $group: { _id: { status: '$status', kind: '$transitionKind' }, count: { $sum: 1 } } },
    ]),
  ]);

  const byId = (rows: { _id: unknown; count: number }[], key: unknown): number =>
    rows.find((r) => r._id === key)?.count ?? 0;

  const sales = salesRow[0];
  const returns = returnRow[0];
  const smsSent = smsRow.find((r) => r._id === 'sms');
  const emailSent = smsRow.find((r) => r._id === 'email');

  const subscriptionRevenue = paymentRows.reduce((sum, r) => sum + r.totalMinor, 0);
  const topUpRevenue = topUpRows.find((r) => r._id === 'approved')?.totalMinor ?? 0;
  const smsRevenue = smsSent?.costMinor ?? 0;
  const emailRevenue = emailSent?.costMinor ?? 0;

  const netSalesMinor = (sales?.grossMinor ?? 0) - (returns?.amountMinor ?? 0);

  ok(res, {
    range: { from: range.from, to: range.to, label: range.label },

    users: {
      total: userRows.reduce((sum, r) => sum + r.count, 0),
      active: byId(userRows, true),
      suspended: byId(userRows, false),
      new: newUsers,
    },

    workspaces: {
      total: tenantRows.reduce((sum, r) => sum + r.count, 0),
      active: byId(tenantRows, 'active'),
      suspended: byId(tenantRows, 'suspended'),
      new: newTenants,
    },

    subscriptions: {
      active: byId(subsRows, 'active'),
      trial: byId(subsRows, 'trial'),
      pastDue: byId(subsRows, 'past_due'),
      cancelled: byId(subsRows, 'cancelled'),
      expired: byId(subsRows, 'expired'),
      monthly: planRows.filter((r) => r._id.interval === 'monthly').reduce((s, r) => s + r.count, 0),
      annual: planRows.filter((r) => r._id.interval === 'yearly').reduce((s, r) => s + r.count, 0),
      byPlan: planRows.map((r) => ({ code: r._id.code, interval: r._id.interval, count: r.count })),
      upgrades: requestRows.filter((r) => r._id.kind === 'upgrade' && r._id.status === 'approved').reduce((s, r) => s + r.count, 0),
      cycleChanges: requestRows.filter((r) => r._id.kind === 'cycle-change' && r._id.status === 'approved').reduce((s, r) => s + r.count, 0),
      downgradeRequests: requestRows.filter((r) => r._id.kind === 'downgrade').reduce((s, r) => s + r.count, 0),
      pendingRequests: requestRows.filter((r) => r._id.status === 'pending').reduce((s, r) => s + r.count, 0),
    },

    revenue: {
      subscriptionMinor: subscriptionRevenue,
      walletTopUpMinor: topUpRevenue,
      smsMinor: smsRevenue,
      emailMinor: emailRevenue,
      // Setup-service revenue has no billing path yet; reported as zero rather
      // than omitted, so the shape stays stable when it is added.
      setupServiceMinor: 0,
      totalMinor: subscriptionRevenue + topUpRevenue + smsRevenue + emailRevenue,
    },

    business: {
      grossSalesMinor: sales?.grossMinor ?? 0,
      discountsMinor: sales?.discountMinor ?? 0,
      returnsMinor: returns?.amountMinor ?? 0,
      returnCount: returns?.count ?? 0,
      netSalesMinor,
      cogsMinor: sales?.cogsMinor ?? 0,
      profitMinor: netSalesMinor - (sales?.cogsMinor ?? 0),
      orders: sales?.orders ?? 0,
      itemsSold: sales?.items ?? 0,
    },

    marketing: {
      smsCount: smsSent?.count ?? 0,
      emailCount: emailSent?.count ?? 0,
      smsRevenueMinor: smsRevenue,
      emailRevenueMinor: emailRevenue,
    },

    payments: {
      byProvider: paymentRows.map((r) => ({ provider: r._id, totalMinor: r.totalMinor, count: r.count })),
      topUps: topUpRows.map((r) => ({ status: r._id, totalMinor: r.totalMinor, count: r.count })),
    },
  });
});

/** Per-workspace league table, sortable by the numbers that matter. */
export const workspaceLeaderboard = asyncHandler(async (req: Request, res: Response) => {
  const input = query<{ preset?: string; from?: Date; to?: Date; sortBy?: string; limit?: number }>(req);
  const { resolveRange } = await import('../reports/reports.service');
  const range = resolveRange({ preset: (input.preset ?? 'last30') as never, from: input.from, to: input.to } as never);

  const rows = await SaleModel.aggregate([
    { $match: { status: 'completed', soldAt: { $gte: range.from, $lte: range.to } } },
    {
      $group: {
        _id: '$tenantId',
        grossMinor: { $sum: '$totalMinor' },
        orders: { $sum: 1 },
        cogsMinor: {
          $sum: {
            $reduce: {
              input: '$items',
              initialValue: 0,
              in: { $add: ['$$value', { $multiply: ['$$this.costPriceMinorSnapshot', '$$this.quantity'] }] },
            },
          },
        },
      },
    },
    { $addFields: { profitMinor: { $subtract: ['$grossMinor', '$cogsMinor'] } } },
    { $sort: { [input.sortBy === 'profit' ? 'profitMinor' : input.sortBy === 'orders' ? 'orders' : 'grossMinor']: -1 } },
    { $limit: Math.min(50, input.limit ?? 20) },
    { $lookup: { from: 'tenants', localField: '_id', foreignField: '_id', as: 'tenant' } },
    { $unwind: { path: '$tenant', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        tenantId: '$_id',
        name: '$tenant.name',
        status: '$tenant.status',
        subscriptionStatus: '$tenant.subscriptionStatus',
        grossMinor: 1,
        orders: 1,
        cogsMinor: 1,
        profitMinor: 1,
      },
    },
  ]);

  ok(res, { range: { from: range.from, to: range.to, label: range.label }, rows });
});
