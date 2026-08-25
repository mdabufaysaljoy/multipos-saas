import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { ROLES, SUBSCRIPTION_STATUS } from '../../config/constants';
import { PaymentModel } from '../../models/Payment';
import { ProductModel } from '../../models/Product';
import { SaleModel } from '../../models/Sale';
import { StoreModel } from '../../models/Store';
import { SubscriptionModel } from '../../models/Subscription';
import { SubscriptionEventModel } from '../../models/SubscriptionEvent';
import { TenantModel } from '../../models/Tenant';
import { UserModel } from '../../models/User';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { body, params, query } from '../../middleware/validate';
import { paymentRegistry } from '../../services/payment/registry';
import { entitlementService } from '../../services/subscription/entitlement.service';
import { subscriptionService } from '../subscriptions/subscriptions.service';
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

/** Platform-wide counters for the admin home screen. */
export const overview = asyncHandler(async (_req: Request, res: Response) => {
  const [tenants, activeTenants, suspended, stores, subscriptions, paidPayments] = await Promise.all([
    TenantModel.countDocuments({}),
    TenantModel.countDocuments({ status: 'active' }),
    TenantModel.countDocuments({ status: 'suspended' }),
    StoreModel.countDocuments({}),
    SubscriptionModel.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    PaymentModel.aggregate<{ totalMinor: number; count: number }>([
      { $match: { status: 'paid' } },
      { $group: { _id: null, totalMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]),
  ]);

  ok(res, {
    tenants,
    activeTenants,
    suspendedTenants: suspended,
    stores,
    subscriptionsByStatus: Object.fromEntries(subscriptions.map((s) => [s._id, s.count])),
    revenue: { totalMinor: paidPayments[0]?.totalMinor ?? 0, paymentCount: paidPayments[0]?.count ?? 0 },
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

  const [owner, stores, users, subscriptions, events, payments, entitlement, usage, productCount, saleCount] =
    await Promise.all([
      UserModel.findById(tenant.ownerUserId).lean(),
      StoreModel.find({ tenantId: id }).lean(),
      UserModel.find({ tenantId: id, deletedAt: null }).select('name email role isActive lastLoginAt').lean(),
      SubscriptionModel.find({ tenantId: id }).sort({ createdAt: -1 }).lean(),
      SubscriptionEventModel.find({ tenantId: id }).sort({ createdAt: -1 }).limit(50).lean(),
      PaymentModel.find({ tenantId: id }).sort({ createdAt: -1 }).limit(50).lean(),
      entitlementService.forTenant(id),
      entitlementService.usage(id),
      ProductModel.countDocuments({ tenantId: id, deletedAt: null }),
      SaleModel.countDocuments({ tenantId: id }),
    ]);

  ok(res, {
    tenant,
    owner: owner ? { id: owner._id, name: owner.name, email: owner.email, phone: owner.phone } : null,
    stores,
    users,
    subscriptions,
    events,
    payments,
    entitlement,
    usage: { ...usage, products: productCount, sales: saleCount },
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

export const listPayments = asyncHandler(async (req: Request, res: Response) => {
  const input = query<ListSubscriptionsInput>(req);
  const { page, limit, skip } = resolvePage(input);

  const filter: Record<string, unknown> = {};
  if (input.status) filter.status = input.status;
  if (input.tenantId) filter.tenantId = input.tenantId;

  const [items, total] = await Promise.all([
    PaymentModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('tenantId', 'name slug').lean(),
    PaymentModel.countDocuments(filter),
  ]);

  paginated(res, items, buildPageMeta(page, limit, total));
});

/** Marks an offline payment as received. A deliberate human confirmation. */
export const markPaymentPaid = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<{ reference?: string; note?: string }>(req);

  const payment = await PaymentModel.findById(id);
  if (!payment) throw ApiError.notFound('Payment not found');
  if (payment.status === 'paid') throw ApiError.badRequest('This payment is already marked as paid');

  payment.status = 'paid';
  payment.paidAt = new Date();
  if (input.reference) payment.providerReference = input.reference;
  payment.metadata = { ...payment.metadata, confirmedBy: req.auth?.name, note: input.note ?? '' };
  await payment.save();

  ok(res, payment.toObject());
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
