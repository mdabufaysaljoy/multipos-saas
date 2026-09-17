import type { TenantContext } from '../../types/express';
import { StoreModel } from '../../models/Store';
import { ALL_PERMISSIONS } from '../../config/permissions';
import { ROLES } from '../../config/constants';
import { DEFAULT_POS_VERTICAL } from '../../config/verticals';
import { isPosVertical } from '../../services/subscription/planEntitlements';
import { pricingService } from '../../services/pricing/pricing.service';
import { type PurchaseInput, type PurchaseQuoteInput, type WorkspaceCheckoutInput, type ScheduleChangeInput } from '../subscriptions/purchase.validators';
import { purchaseService } from '../subscriptions/purchase.service';
import { describeEntitlements } from '../../services/entitlements/entitlementEngine';
import { assertRenewed, renewalSucceeded } from '../subscriptions/renewalResponse';
import { renewWorkspaceSubscription } from '../../services/subscription/walletRenewal.service';
import type { Request, Response } from 'express';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/apiResponse';
import { body } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { subscriptionService } from '../subscriptions/subscriptions.service';
import { renewalService } from '../subscriptions/renewal.service';
import { workspaceBillingItem } from '../account/accountBilling.service';
import { getWorkspaceSubscription } from '../../services/subscription/workspaceSubscription.service';
import { presentWorkspace, workspaceService } from './workspaces.service';
import type { CancelWorkspaceSubscriptionInput, CreateWorkspaceInput, UpdateWorkspaceInput } from './workspaces.validators';

/** Active POS types from the platform catalog, and which can be created today. */
export const verticals = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await workspaceService.verticalOptions());
});

/** The authenticated account's workspaces. No id in the request to tamper with. */
export const list = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await workspaceService.list(req.account!.id));
});

/** One workspace, already verified as owned by `requireWorkspaceAccess`. */
export const get = asyncHandler(async (req: Request, res: Response) => {
  ok(res, presentWorkspace(req.workspace!));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const workspace = req.workspace!;
  const input = body<UpdateWorkspaceInput>(req);
  const updated = await workspaceService.update(workspace, input);

  await recordAudit(req, {
    action: 'workspace.updated',
    targetTenantId: workspace._id,
    targetUserId: req.auth!.id,
    targetLabel: updated.businessName,
    oldValue: {
      businessName: workspace.name,
      contactEmail: workspace.contactEmail,
      contactPhone: workspace.contactPhone,
      settings: workspace.settings,
    },
    newValue: input,
  });

  ok(res, updated);
});

/** This workspace's own subscription (ownership already verified). */
export const subscription = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await getWorkspaceSubscription(req.workspace!._id));
});

/** Cancels ONE workspace's subscription. The account's other workspaces are not touched. */
export const cancelSubscription = asyncHandler(async (req: Request, res: Response) => {
  const workspace = req.workspace!;
  const input = body<CancelWorkspaceSubscriptionInput>(req);
  const before = await getWorkspaceSubscription(workspace._id);
  if (!before.subscription) throw ApiError.notFound('No subscription found for this workspace');

  await subscriptionService.cancel(workspace._id, input, { id: req.auth!.id, name: req.auth!.name });
  const after = await getWorkspaceSubscription(workspace._id);

  await recordAudit(req, {
    action: 'workspace.subscription_cancelled',
    targetTenantId: workspace._id,
    targetUserId: req.auth!.id,
    targetLabel: workspace.name,
    oldValue: { status: before.subscription.status, planCode: before.subscription.planCode, currentPeriodEnd: before.subscription.currentPeriodEnd },
    newValue: { status: after.subscription?.status, immediate: input.immediate, reason: input.reason },
  });

  ok(res, after);
});

const actorOn = (req: Request) => ({ tenantId: req.workspace!._id, userId: req.auth!.id, userName: req.auth!.name });

/** Billing changes are refused for a workspace the platform has suspended; viewing is not. */
const assertNotSuspended = (req: Request) => {
  if (req.workspace!.status === 'suspended') throw ApiError.forbidden('This workspace is suspended. Please contact support.');
};

const auditBilling = (req: Request, action: string, oldValue: Record<string, unknown>, newValue: Record<string, unknown>) =>
  recordAudit(req, { action, targetTenantId: req.workspace!._id, targetUserId: req.auth!.id, targetLabel: req.workspace!.name, oldValue, newValue });

/** Turns automatic wallet renewal on or off for ONE owned workspace. */
export const setAutoRenew = asyncHandler(async (req: Request, res: Response) => {
  assertNotSuspended(req);
  const { enabled } = body<{ enabled: boolean }>(req);
  const before = await renewalService.info(req.workspace!._id);
  await renewalService.setAutoRenew(actorOn(req), enabled);
  await auditBilling(req, 'workspace.subscription_auto_renew_changed', { autoRenew: before.subscription?.autoRenew ?? null }, { enabled });
  ok(res, await workspaceBillingItem(req.workspace!));
});

/**
 * Schedules ONE owned workspace's plan for its next renewal (a downgrade, or
 * any change the owner does not want to pay for now). The renewal service
 * applies the transition rules: nothing changes until renewal, and usage over a
 * downgrade's limits is reported back so it can be fixed in time.
 */
export const scheduleChange = asyncHandler(async (req: Request, res: Response) => {
  assertNotSuspended(req);
  const input = body<ScheduleChangeInput>(req);
  const before = await renewalService.info(req.workspace!._id);
  const result = await renewalService.scheduleChange(actorOn(req), input);
  await auditBilling(
    req,
    'workspace.subscription_change_scheduled',
    { plan: before.subscription?.planCode ?? null, scheduledPlan: before.scheduledChange?.planCode ?? null },
    { scheduledPlan: result.scheduledChange?.planCode ?? null, billingCycle: input.billingCycle, kind: result.kind, breaches: result.breaches.length },
  );
  ok(res, { ...(await workspaceBillingItem(req.workspace!)), change: { kind: result.kind, breaches: result.breaches } });
});

/** Withdraws the plan change scheduled for ONE owned workspace's next renewal. */
export const cancelScheduledChange = asyncHandler(async (req: Request, res: Response) => {
  assertNotSuspended(req);
  const before = await renewalService.info(req.workspace!._id);
  await renewalService.cancelScheduledChange(actorOn(req));
  await auditBilling(req, 'workspace.subscription_change_withdrawn', { scheduledPlan: before.scheduledChange?.planCode ?? null }, { scheduledPlan: null });
  ok(res, await workspaceBillingItem(req.workspace!));
});

/** Withdraws a pending cancellation on ONE owned workspace. */
export const reactivateSubscription = asyncHandler(async (req: Request, res: Response) => {
  assertNotSuspended(req);
  const updated = await subscriptionService.reactivate(req.workspace!._id, { id: req.auth!.id, name: req.auth!.name });
  await auditBilling(req, 'workspace.subscription_reactivated', { cancelAtPeriodEnd: true }, { status: updated.status, autoRenew: updated.autoRenew });
  ok(res, await workspaceBillingItem(req.workspace!));
});

/**
 * Renews ONE owned workspace's subscription now, from the account wallet. The
 * body is empty: the price is the pricing engine's, the workspace is the
 * verified route parameter, the account is the session's.
 */
export const renewSubscription = asyncHandler(async (req: Request, res: Response) => {
  assertNotSuspended(req);
  const workspace = req.workspace!;
  const result = await renewWorkspaceSubscription(workspace._id, { trigger: 'manual', actor: { id: req.auth!.id, name: req.auth!.name } });
  await auditBilling(req, renewalSucceeded(result) ? 'workspace.subscription_renewed' : 'workspace.subscription_renewal_refused', {}, {
    state: result.state,
    amountMinor: result.amountMinor,
    walletBalanceMinor: result.walletBalanceMinor,
    renewedSubscriptionId: result.renewedSubscriptionId ? String(result.renewedSubscriptionId) : null,
  });
  assertRenewed(result);
  ok(res, { billing: result, workspace: await workspaceBillingItem(workspace) });
});

/** One owned workspace's entitlements, resolved for that workspace only. */
export const entitlements = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await describeEntitlements(req.workspace!._id));
});

/**
 * The owner acting on one of their workspaces for billing. Ownership was just
 * verified by `requireWorkspaceAccess`; the owner is that workspace's admin.
 * Billing never acts on a branch, so a workspace without one yet still works.
 */
async function ownerContext(req: Request): Promise<TenantContext> {
  const workspace = req.workspace!;
  const store = await StoreModel.findOne({ tenantId: workspace._id, isActive: true, deletedAt: null }).sort({ isDefault: -1, createdAt: 1 }).select('_id').lean();
  return {
    tenantId: workspace._id,
    vertical: isPosVertical(workspace.vertical) ? workspace.vertical : DEFAULT_POS_VERTICAL,
    storeId: store?._id ?? workspace._id,
    userId: req.auth!.id,
    userName: req.auth!.name,
    role: ROLES.ADMIN,
    permissions: [...ALL_PERMISSIONS],
    isAdmin: true,
    can: () => true,
  };
}

/** The plans this workspace can buy - for its OWN POS type - and what it is on now. */
export const planOptions = asyncHandler(async (req: Request, res: Response) => {
  const workspace = req.workspace!;
  const posType = isPosVertical(workspace.vertical) ? workspace.vertical : DEFAULT_POS_VERTICAL;
  const [catalog, current] = await Promise.all([pricingService.catalog(posType), getWorkspaceSubscription(workspace._id)]);
  ok(res, {
    workspace: { id: workspace._id, name: workspace.name, posType },
    isActive: current.isActive,
    current: current.subscription
      ? { planCode: current.subscription.planCode, planName: current.subscription.planName, billingCycle: current.subscription.billingCycle, status: current.subscription.status, currentPeriodEnd: current.subscription.currentPeriodEnd }
      : null,
    catalog,
  });
});

/** What the workspace would pay for a plan and cycle, and whether the move is allowed. Buys nothing. */
export const checkoutQuote = asyncHandler(async (req: Request, res: Response) => {
  assertNotSuspended(req);
  ok(res, await purchaseService.quote(await ownerContext(req), body<PurchaseQuoteInput>(req)));
});

/**
 * Checkout for one owned workspace. Before any payment the server revalidates
 * everything itself: the account and workspace (verified above), the POS type
 * (the workspace's own), the plan and billing cycle (the catalog), the current
 * price (the pricing engine) and eligibility (the plan-change rules). A price
 * the customer confirmed that no longer matches is refused, never charged.
 */
export const checkout = asyncHandler(async (req: Request, res: Response) => {
  assertNotSuspended(req);
  const { expectedPayableMinor, ...purchase } = body<WorkspaceCheckoutInput>(req);
  const ctx = await ownerContext(req);
  const quote = await purchaseService.quote(ctx, { plan: purchase.plan, billingCycle: purchase.billingCycle, couponCode: purchase.couponCode });
  if (expectedPayableMinor !== undefined && expectedPayableMinor !== quote.payableMinor) {
    throw ApiError.conflict('The price has changed since you saw it. Review the new price and confirm again.', {
      reason: 'PRICE_CHANGED',
      payableMinor: quote.payableMinor,
      currency: quote.currency,
    });
  }
  const result = await purchaseService.purchase(ctx, purchase as PurchaseInput);
  await auditBilling(req, 'workspace.checkout', {}, {
    plan: purchase.plan,
    billingCycle: purchase.billingCycle,
    paymentMethod: purchase.paymentMethod,
    posType: quote.posType,
    payableMinor: quote.payableMinor,
  });
  created(res, { quote, result });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw ApiError.unauthorized();
  if (req.auth.isPlatformAdmin) {
    throw ApiError.forbidden('Platform administrators create workspaces from the platform panel');
  }

  const input = body<CreateWorkspaceInput>(req);
  const result = await workspaceService.create(req.auth.id, input);

  await recordAudit(req, {
    action: 'workspace.created',
    targetTenantId: result.workspace.id,
    targetUserId: req.auth.id,
    targetLabel: result.workspace.name,
    newValue: { vertical: result.workspace.vertical, trial: result.trial },
  });

  created(res, result);
});
