import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { planForVertical, resolvePlanForVertical } from '../../services/subscription/planEntitlements';
import { PAYMENT_STATUS, SUBSCRIPTION_STATUS } from '../../config/constants';
import { DEFAULT_POS_VERTICAL } from '../../config/verticals';
import { PaymentModel } from '../../models/Payment';
import { SubscriptionModel } from '../../models/Subscription';
import { UpgradeRequestModel } from '../../models/UpgradeRequest';
import { recordAudit } from '../../services/audit/audit.service';
import { tryOfferFor } from '../../services/subscription/purchasePricing.service';

/** Subscriptions that still give a workspace access (a cancelled one runs to its period end). */
const RUNNING_STATUSES: string[] = [
  SUBSCRIPTION_STATUS.TRIAL,
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.PAST_DUE,
  SUBSCRIPTION_STATUS.CANCELLED,
];
import { assertPlanScope } from '../../services/subscription/planScope.service';
import type { CreatePlanInput, PlanAdminListQuery, PlanCatalogQuery, UpdatePlanInput } from './plans.validators';

/**
 * Public pricing page data - active, public plans only, as ONE vertical sees
 * them (Clothing by default). Plans not offered to that vertical are left out,
 * and the override configuration itself is never exposed.
 */
export const listPublic = asyncHandler(async (req: Request, res: Response) => {
  const { vertical } = query<PlanCatalogQuery>(req);
  const plans = await SubscriptionPlanModel.find({ isActive: true, isPublic: true })
    .sort({ interval: 1, sortOrder: 1 })
    .lean();
  // Prices shown are the pricing engine's for this vertical, so the pricing page
  // and every purchase path show the same number. A plan with no purchasable price is left out.
  const priced = await Promise.all(
    plans
      .filter((plan) => resolvePlanForVertical(plan, vertical).isAvailable)
      .map(async (plan) => {
        const offer = await tryOfferFor(vertical, plan);
        return offer
          ? {
              ...planForVertical(plan, vertical),
              priceMinor: offer.listPriceMinor,
              currency: offer.currency,
              catalogPlanCode: offer.catalogPlanCode,
              billingCycle: offer.billingCycle,
            }
          : null;
      }),
  );
  ok(res, priced.filter((plan) => plan !== null));
});

/**
 * Platform admin view - everything, including hidden and inactive plans.
 * `?posProductCode=restaurant` narrows to one POS type, `=shared` to shared plans.
 */
export const listAll = asyncHandler(async (req: Request, res: Response) => {
  const { posProductCode } = query<PlanAdminListQuery>(req);
  // `{ posProductCode: null }` also matches plans stored before the field existed.
  const filter = posProductCode === 'shared' ? { posProductCode: null } : posProductCode ? { posProductCode } : {};
  const [plans, running] = await Promise.all([
    SubscriptionPlanModel.find(filter).sort({ interval: 1, sortOrder: 1 }).lean(),
    SubscriptionModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { status: { $in: RUNNING_STATUSES } } },
      { $group: { _id: '$planId', count: { $sum: 1 } } },
    ]),
  ]);
  const runningByPlan = new Map(running.map((row) => [String(row._id), row.count]));
  ok(
    res,
    plans.map((plan) => ({ ...plan, runningSubscriptions: runningByPlan.get(String(plan._id)) ?? 0 })),
  );
});

/**
 * Who is on a plan: subscriptions by status, the workspaces currently running
 * on it (newest period end last), and payments or requests still pending.
 * Lets an admin see the effect of an edit before making it.
 */
export const usage = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const plan = await SubscriptionPlanModel.findById(id).select('_id code name isActive posProductCode').lean();
  if (!plan) throw ApiError.notFound('Plan not found');

  const [byStatus, running, pendingPayments, pendingRequests] = await Promise.all([
    SubscriptionModel.aggregate<{ _id: string; count: number }>([
      { $match: { planId: plan._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    SubscriptionModel.find({ planId: plan._id, status: { $in: RUNNING_STATUSES } })
      .sort({ currentPeriodEnd: 1 })
      .limit(100)
      .populate<{ tenantId: { _id: Types.ObjectId; name: string; vertical?: string; status: string } | null }>('tenantId', 'name vertical status')
      .select('tenantId status currentPeriodEnd planSnapshot.priceMinor planSnapshot.currency')
      .lean(),
    PaymentModel.countDocuments({ planId: plan._id, status: PAYMENT_STATUS.PENDING }),
    UpgradeRequestModel.countDocuments({ planId: plan._id, status: 'pending' }),
  ]);

  const subscriptionsByStatus = Object.fromEntries(byStatus.map((row) => [row._id, row.count]));
  ok(res, {
    plan,
    subscriptionsByStatus,
    runningCount: RUNNING_STATUSES.reduce((sum, status) => sum + (subscriptionsByStatus[status] ?? 0), 0),
    pendingPayments,
    pendingRequests,
    workspaces: running.map((subscription) => ({
      subscriptionId: subscription._id,
      tenantId: subscription.tenantId?._id ?? null,
      name: subscription.tenantId?.name ?? 'Deleted workspace',
      vertical: subscription.tenantId?.vertical ?? DEFAULT_POS_VERTICAL,
      workspaceStatus: subscription.tenantId?.status ?? null,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      priceMinor: subscription.planSnapshot?.priceMinor ?? null,
      currency: subscription.planSnapshot?.currency ?? null,
    })),
  });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const input = body<CreatePlanInput>(req);
  const duplicate = await SubscriptionPlanModel.findOne({ code: input.code }).select('_id').lean();
  if (duplicate) throw ApiError.conflict('A plan with this code already exists');

  const posProductCode = input.posProductCode ?? null;
  await assertPlanScope({ posProductCode, verticalOverrides: input.verticalOverrides ?? [] });

  const plan = await SubscriptionPlanModel.create({ ...input, posProductCode });
  await recordAudit(req, {
    action: 'plan.created',
    targetLabel: plan.code,
    newValue: { code: plan.code, name: plan.name, priceMinor: plan.priceMinor, interval: plan.interval, posProductCode },
  });
  created(res, plan.toObject());
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<UpdatePlanInput>(req);

  const plan = await SubscriptionPlanModel.findById(id);
  if (!plan) throw ApiError.notFound('Plan not found');

  const before = {
    code: plan.code,
    name: plan.name,
    priceMinor: plan.priceMinor,
    isActive: plan.isActive,
    posProductCode: plan.posProductCode ?? null,
  };

  // Scope is checked against the plan as it will be after this edit, before
  // anything is changed, so a refused edit changes nothing.
  await assertPlanScope(
    {
      posProductCode: input.posProductCode !== undefined ? input.posProductCode : (plan.posProductCode ?? null),
      verticalOverrides: input.verticalOverrides ?? plan.verticalOverrides ?? [],
    },
    { _id: plan._id, posProductCode: plan.posProductCode },
  );
  if (input.posProductCode !== undefined) plan.posProductCode = input.posProductCode;

  if (input.code && input.code !== plan.code) {
    const duplicate = await SubscriptionPlanModel.findOne({ code: input.code, _id: { $ne: id } }).select('_id').lean();
    if (duplicate) throw ApiError.conflict('A plan with this code already exists');
    plan.code = input.code;
  }

  const scalars = ['name', 'description', 'interval', 'priceMinor', 'currency', 'trialDays', 'isActive', 'isPublic', 'sortOrder', 'tier'] as const;
  for (const key of scalars) {
    if (input[key] !== undefined) (plan as unknown as Record<string, unknown>)[key] = input[key];
  }

  // Merge nested blocks so a partial edit cannot wipe unrelated flags.
  if (input.features) Object.assign(plan.features, input.features);
  if (input.limits) Object.assign(plan.limits, input.limits);
  // Overrides are replaced as a whole list: the admin sends the full, validated
  // set. Omitting the field leaves the existing overrides untouched.
  if (input.verticalOverrides) plan.set('verticalOverrides', input.verticalOverrides);

  await plan.save();
  await recordAudit(req, { action: 'plan.updated', targetLabel: plan.code, oldValue: before, newValue: input });

  // NOTE: existing subscriptions keep their planSnapshot, so a price change
  // never rewrites a period a customer has already paid for.
  ok(res, plan.toObject());
});

export const deactivate = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  const plan = await SubscriptionPlanModel.findByIdAndUpdate(id, { $set: { isActive: false } }, { new: true }).lean();
  if (!plan) throw ApiError.notFound('Plan not found');
  await recordAudit(req, { action: 'plan.deactivated', targetLabel: plan.code, newValue: { isActive: false } });
  ok(res, plan);
});
