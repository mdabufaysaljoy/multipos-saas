import { describeEntitlements } from '../../services/entitlements/entitlementEngine';
import { recordAudit } from '../../services/audit/audit.service';
import { assertRenewed, renewalSucceeded } from './renewalResponse';
import { renewWorkspaceSubscription } from '../../services/subscription/walletRenewal.service';
import type { Request, Response } from 'express';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, buildPageMeta, paginated } from '../../utils/apiResponse';
import { body, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { subscriptionService } from './subscriptions.service';
import { upgradeService } from './upgrades.service';
import { getPlatformSettings } from '../../models/PlatformSettings';
import { couponService } from '../coupons/coupons.service';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { resolvePlanForVertical, verticalOfTenant } from '../../services/subscription/planEntitlements';
import type { CancelSubscriptionInput, SubmitUpgradeInput } from './subscriptions.validators';
import type { Types } from 'mongoose';
import { params } from '../../middleware/validate';
import { purchaseService } from './purchase.service';
import type { PurchaseInput, PurchaseQuoteInput, ScheduleChangeInput } from './purchase.validators';
import { renewalService } from './renewal.service';
import { offerForPlan, tryOfferFor } from '../../services/subscription/purchasePricing.service';
import { getInvoice, listInvoices } from '../../services/billing/invoice.service';
import { type InvoiceParams, type WorkspaceInvoiceQuery } from './invoices.validators';

/** The tenant's own subscription screen. */
export const current = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, await subscriptionService.current(ctx.tenantId));
});

export const history = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, await subscriptionService.history(ctx.tenantId));
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  if (!req.auth) throw ApiError.unauthorized();
  const result = await subscriptionService.cancel(ctx.tenantId, body<CancelSubscriptionInput>(req), {
    id: req.auth.id,
    name: req.auth.name,
  });
  ok(res, result);
});

export const reactivate = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  if (!req.auth) throw ApiError.unauthorized();
  ok(res, await subscriptionService.reactivate(ctx.tenantId, { id: req.auth.id, name: req.auth.name }));
});

/** What buying a plan would cost this workspace, from the server's pricing. Buys nothing. */
export const purchaseQuote = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await purchaseService.quote(getContext(req), body<PurchaseQuoteInput>(req)));
});

/** Buys a plan in catalog terms. A replayed attempt answers 200 with the original result. */
export const purchase = asyncHandler(async (req: Request, res: Response) => {
  const result = await purchaseService.purchase(getContext(req), body<PurchaseInput>(req));
  if (result.replayed) ok(res, result);
  else created(res, result);
});

/** When the period ends, what renews, and at what price. */
export const renewalInfo = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await renewalService.info(getContext(req).tenantId));
});

export const setAutoRenew = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await renewalService.setAutoRenew(getContext(req), body<{ enabled: boolean }>(req).enabled));
});

export const scheduleChange = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await renewalService.scheduleChange(getContext(req), body<ScheduleChangeInput>(req)));
});

export const cancelScheduledChange = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await renewalService.cancelScheduledChange(getContext(req)));
});

/** Customer submits a manual-payment upgrade. Approval is a separate step. */
export const submitUpgrade = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  created(res, await upgradeService.submit(ctx, body<SubmitUpgradeInput>(req)));
});

export const listUpgradeRequests = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await upgradeService.listForTenant(getContext(req).tenantId));
});

export const cancelUpgradeRequest = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await upgradeService.cancel(getContext(req), id));
});

/** Payment instructions the platform admin has configured, for the upgrade UI. */
export const paymentInstructions = asyncHandler(async (_req: Request, res: Response) => {
  const settings = await getPlatformSettings();
  ok(res, {
    instructions: settings.paymentInstructions.filter((i) => i.isActive),
    supportEmail: settings.supportEmail,
    supportPhone: settings.supportPhone,
  });
});

/** Previews a coupon against a plan without consuming it. */
export const quoteCoupon = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = body<{ code: string; planId: Types.ObjectId }>(req);

  const plan = await SubscriptionPlanModel.findOne({ _id: input.planId, isActive: true }).lean();
  if (!plan || !resolvePlanForVertical(plan, await verticalOfTenant(ctx.tenantId)).isAvailable) {
    throw ApiError.notFound('Plan not found');
  }

  // The discount is worked out on the engine price for this workspace, never the plan's stored price.
  const offer = await offerForPlan(ctx.tenantId, plan);
  ok(res, await couponService.quote({
    code: input.code,
    tenantId: ctx.tenantId,
    planId: plan._id,
    amountMinor: offer.listPriceMinor,
  }));
});

/**
 * Every plan, classified against the tenant's current one, with the exact
 * reason a locked option is unavailable and what blocks a downgrade.
 */
export const planOptions = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const { evaluateTransition } = await import('./transitions');
  const { PRIMARY_FIRST, SubscriptionModel } = await import('../../models/Subscription');
  const { entitlementService } = await import('../../services/subscription/entitlement.service');

  const [plans, subscription, usage, entitlement, vertical] = await Promise.all([
    SubscriptionPlanModel.find({ isActive: true, isPublic: true }).sort({ interval: 1, sortOrder: 1 }).lean(),
    SubscriptionModel.findOne({ tenantId: ctx.tenantId }).sort(PRIMARY_FIRST).lean(),
    entitlementService.usage(ctx.tenantId),
    entitlementService.forTenant(ctx.tenantId),
    verticalOfTenant(ctx.tenantId),
  ]);

  const current = subscription
    ? plans.find((p) => p.code === subscription.planSnapshot?.code) ?? null
    : null;

  // Every option is priced and limited as THIS workspace's vertical buys it;
  // plans not offered to that vertical are not options at all.
  // Priced by the pricing engine for this vertical; a plan with no purchasable price is not an option.
  const offered = (
    await Promise.all(
      plans
        .map((plan) => ({ plan, resolved: resolvePlanForVertical(plan, vertical) }))
        .filter(({ resolved }) => resolved.isAvailable)
        .map(async (entry) => ({ ...entry, offer: await tryOfferFor(vertical, entry.plan) })),
    )
  ).flatMap((entry) => (entry.offer ? [{ ...entry, offer: entry.offer }] : []));

  ok(res, {
    currentPlanCode: current?.code ?? null,
    usage: { vertical: usage.vertical, branches: usage.stores, staff: usage.staff, products: usage.products },
    options: offered.map(({ plan, resolved, offer }) => {
      const verdict = evaluateTransition(current, { ...plan, limits: resolved.limits }, {
        vertical: usage.vertical,
        branches: usage.stores,
        staff: usage.staff,
        products: usage.products,
        customers: usage.customers,
        storageBytes: usage.storageBytes,
      });

      // Re-buying the plan you are on is a no-op while it runs, but it is the
      // way back in once it has lapsed. Mirrors upgrades.service.submit().
      const isRenewal = verdict.kind === 'current' && !entitlement.isUsable;

      return {
        planId: plan._id,
        code: plan.code,
        name: plan.name,
        interval: plan.interval,
        tier: plan.tier,
        priceMinor: offer.listPriceMinor,
        currency: offer.currency,
        catalogPlanCode: offer.catalogPlanCode,
        billingCycle: offer.billingCycle,
        features: resolved.features,
        limits: resolved.limits,
        kind: isRenewal ? 'renewal' : verdict.kind,
        /** True when the customer can move now, with no cleanup. */
        canProceed: isRenewal ? true : verdict.canProceed,
        allowedDirect: isRenewal ? true : verdict.canProceed,
        requiresResourceCheck: isRenewal ? false : verdict.requiresResourceCheck,
        reason: isRenewal ? '' : verdict.reason,
        breaches: verdict.breaches,
      };
    }),
  });
});

/** This workspace's invoices; the workspace comes from the session. */
export const invoices = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await listInvoices([ctx.tenantId], query<WorkspaceInvoiceQuery>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const invoice = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  ok(res, await getInvoice(params<InvoiceParams>(req).invoiceId, [ctx.tenantId]));
});

/** Renews this workspace's subscription now, from the account wallet. Needs the wallet permission too. */
export const renew = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await renewWorkspaceSubscription(ctx.tenantId, { trigger: 'manual', actor: { id: ctx.userId, name: ctx.userName } });
  await recordAudit(req, {
    action: renewalSucceeded(result) ? 'workspace.subscription_renewed' : 'workspace.subscription_renewal_refused',
    targetTenantId: ctx.tenantId,
    targetUserId: ctx.userId,
    newValue: { state: result.state, amountMinor: result.amountMinor, walletBalanceMinor: result.walletBalanceMinor },
  });
  ok(res, { billing: assertRenewed(result) });
});

/** This workspace's entitlements, resolved on the server. */
export const entitlements = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await describeEntitlements(getContext(req).tenantId));
});
