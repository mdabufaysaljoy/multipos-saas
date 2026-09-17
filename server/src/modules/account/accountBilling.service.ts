import { posCatalogService } from '../../services/posCatalog/posCatalog.service';
import { env } from '../../config/env';
import { AccountModel } from '../../models/Account';
import type { Types } from 'mongoose';
import { TenantModel } from '../../models/Tenant';
import { walletService } from '../../services/wallet/wallet.service';
import { getWorkspaceSubscription } from '../../services/subscription/workspaceSubscription.service';
import { renewalService } from '../subscriptions/renewal.service';

/** Automatic renewals this close are added up against the wallet balance. */
export const UPCOMING_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
/** A trial this close to its end is flagged. */
const TRIAL_ENDING_MS = 3 * DAY_MS;

type WorkspaceRow = { _id: Types.ObjectId; name: string; vertical?: string; status: string };

export type BillingAttention =
  | 'suspended'
  | 'no_subscription'
  | 'expired'
  | 'in_grace'
  | 'renewal_failed'
  | 'cancelling'
  | 'trial_ending'
  | 'wallet_short';

/**
 * One workspace's billing, as its owner sees it on the account billing page.
 * Composed from the existing reads - the workspace subscription service and the
 * renewal summary - so the numbers match the workspace's own subscription page.
 */
export async function workspaceBillingItem(workspace: WorkspaceRow, now = new Date()) {
  const [overview, renewal] = await Promise.all([getWorkspaceSubscription(workspace._id), renewalService.info(workspace._id, now)]);
  const subscription = overview.subscription;
  const running = renewal.subscription;

  const attention: BillingAttention[] = [];
  if (workspace.status === 'suspended' || subscription?.status === 'suspended') attention.push('suspended');
  else if (!subscription) attention.push('no_subscription');
  else if (subscription.status === 'expired') attention.push('expired');
  else {
    if (running?.graceEndsAt) attention.push('in_grace');
    if ((running?.failedRenewalAttempts ?? 0) > 0) attention.push('renewal_failed');
    if (subscription.cancelAtPeriodEnd) attention.push('cancelling');
    if (subscription.status === 'trialing' && subscription.currentPeriodEnd.getTime() - now.getTime() <= TRIAL_ENDING_MS) attention.push('trial_ending');
  }

  return {
    workspace: { id: workspace._id, name: workspace.name, vertical: workspace.vertical ?? 'clothing', status: workspace.status },
    isActive: overview.isActive,
    daysRemaining: overview.daysRemaining,
    subscription,
    renewal: {
      manageable: running?.manageable ?? false,
      autoRenew: running?.autoRenew ?? false,
      renewsAutomatically: running?.renewsAutomatically ?? false,
      graceEndsAt: running?.graceEndsAt ?? null,
      failedRenewalAttempts: running?.failedRenewalAttempts ?? 0,
      renewalWindowOpen: renewal.renewalWindowOpen,
      nextRenewal: renewal.nextRenewal,
      scheduledChange: renewal.scheduledChange,
    },
    attention,
  };
}

/**
 * Billing across every workspace the account owns: each workspace's plan and
 * renewal, the shared account wallet, and the automatic renewals coming up in
 * the next UPCOMING_WINDOW_DAYS - taken in date order against the balance, so
 * the owner sees which one the wallet will run out on.
 *
 * Only the account's own workspaces are read; the account comes from the
 * session, never from the request.
 */
export async function accountBillingOverview(accountId: Types.ObjectId, now = new Date()) {
  const workspaces = await TenantModel.find({ accountId }).sort({ createdAt: 1 }).select('_id name vertical status').lean<WorkspaceRow[]>();
  const [items, posTypes] = await Promise.all([Promise.all(workspaces.map((workspace) => workspaceBillingItem(workspace, now))), posCatalogService.customerOptions()]);
  const labels = new Map(posTypes.map((option) => [option.vertical, option.label]));
  for (const item of items) Object.assign(item.workspace, { posTypeLabel: labels.get(item.workspace.vertical) ?? item.workspace.vertical });
  // One wallet per account: any of its workspaces resolves to it.
  const wallet = workspaces.length > 0 ? await walletService.balance(workspaces[0]._id) : null;
  const walletCurrency = wallet?.currency ?? 'BDT';
  const available = wallet && !wallet.isFrozen ? wallet.balanceMinor : 0;
  const horizon = now.getTime() + UPCOMING_WINDOW_DAYS * DAY_MS;

  const due = items
    .flatMap((item) => {
      const next = item.renewal.nextRenewal;
      if (!item.subscription || !item.renewal.renewsAutomatically || !next || next.amountMinor === null || !next.available) return [];
      if (item.subscription.currentPeriodEnd.getTime() > horizon) return [];
      return [
        {
          workspaceId: item.workspace.id,
          workspaceName: item.workspace.name,
          planName: next.name,
          catalogPlanCode: next.catalogPlanCode,
          billingCycle: next.billingCycle,
          amountMinor: next.amountMinor,
          currency: next.currency,
          renewsAt: item.subscription.currentPeriodEnd,
          overdue: Boolean(item.renewal.graceEndsAt),
        },
      ];
    })
    .sort((a, b) => a.renewsAt.getTime() - b.renewsAt.getTime());

  let runningMinor = 0;
  const renewals = due.map((row) => {
    if (row.currency !== walletCurrency) return { ...row, coveredByWallet: false };
    runningMinor += row.amountMinor;
    return { ...row, coveredByWallet: runningMinor <= available };
  });
  for (const row of renewals) {
    if (row.coveredByWallet) continue;
    const item = items.find((candidate) => String(candidate.workspace.id) === String(row.workspaceId));
    if (item && !item.attention.includes('wallet_short')) item.attention.push('wallet_short');
  }

  const byStatus: Record<string, number> = {};
  for (const item of items) {
    const key = item.subscription?.status ?? 'none';
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }

  return {
    wallet: wallet ? { balanceMinor: wallet.balanceMinor, currency: wallet.currency, isFrozen: wallet.isFrozen } : null,
    totals: {
      workspaces: items.length,
      active: items.filter((item) => item.isActive).length,
      needsAttention: items.filter((item) => item.attention.length > 0).length,
      byStatus,
    },
    upcoming: {
      windowDays: UPCOMING_WINDOW_DAYS,
      currency: walletCurrency,
      dueMinor: runningMinor,
      /** What the wallet would hold after these renewals (negative when it cannot cover them). */
      balanceAfterMinor: available - runningMinor,
      shortfallMinor: Math.max(0, runningMinor - available),
      renewals,
    },
    workspaces: items,
  };
}

/**
 * Every workspace's next renewal against the one account wallet: when, how
 * much (the pricing engine's price for the plan it renews into), the status,
 * whether it renews by itself, whether it can be renewed now - and what the
 * wallet holds before and after all automatic renewals of the next cycle.
 */
export async function accountRenewals(accountId: Types.ObjectId, now = new Date(), computed?: Awaited<ReturnType<typeof accountBillingOverview>>) {
  const overview = computed ?? (await accountBillingOverview(accountId, now));
  const balanceMinor = overview.wallet && !overview.wallet.isFrozen ? overview.wallet.balanceMinor : 0;
  const renewals = overview.workspaces
    .map((item) => {
      const subscription = item.subscription;
      const amount = item.renewal.nextRenewal?.available ? (item.renewal.nextRenewal.amountMinor ?? null) : null;
      const ended = subscription ? subscription.currentPeriodEnd.getTime() <= now.getTime() : false;
      return {
        workspace: item.workspace,
        subscriptionId: subscription?.id ?? null,
        status: subscription?.status ?? 'none',
        planName: item.renewal.nextRenewal?.name ?? subscription?.planName ?? null,
        billingCycle: item.renewal.nextRenewal?.billingCycle ?? subscription?.billingCycle ?? null,
        nextRenewalAt: subscription?.currentPeriodEnd ?? null,
        renewalAmountMinor: amount,
        currency: item.renewal.nextRenewal?.currency ?? subscription?.currency ?? overview.upcoming.currency,
        renewsAutomatically: item.renewal.renewsAutomatically,
        graceEndsAt: item.renewal.graceEndsAt,
        canRenewNow:
          Boolean(subscription) &&
          amount !== null &&
          subscription!.status !== 'suspended' &&
          item.workspace.status !== 'suspended' &&
          !subscription!.cancelAtPeriodEnd &&
          (item.renewal.renewalWindowOpen || ended),
      };
    })
    .sort((a, b) => (a.nextRenewalAt?.getTime() ?? Infinity) - (b.nextRenewalAt?.getTime() ?? Infinity));

  const automatic = renewals.filter((row) => row.renewsAutomatically && row.renewalAmountMinor !== null);
  const nextCycleMinor = automatic.reduce((sum, row) => sum + (row.renewalAmountMinor ?? 0), 0);
  return {
    wallet: overview.wallet,
    renewals,
    totals: {
      currency: overview.wallet?.currency ?? overview.upcoming.currency,
      walletBalanceMinor: balanceMinor,
      /** All automatic renewals of the next cycle, whenever they fall. */
      nextCycleMinor,
      balanceAfterMinor: balanceMinor - nextCycleMinor,
      shortfallMinor: Math.max(0, nextCycleMinor - balanceMinor),
    },
  };
}

/**
 * The account's central dashboard: every workspace with its POS type, plan,
 * status, next renewal and whether it can be opened - plus the POS types the
 * owner can add next. Only this account's workspaces are ever read.
 */
export async function accountDashboard(accountId: Types.ObjectId, now = new Date()) {
  const [account, overview, options] = await Promise.all([
    AccountModel.findById(accountId).select('name status').lean(),
    accountBillingOverview(accountId, now),
    posCatalogService.customerOptions(),
  ]);
  const renewals = await accountRenewals(accountId, now, overview);
  const labels = new Map(options.map((option) => [option.vertical, option.label]));
  const renewalOf = new Map(renewals.renewals.map((row) => [String(row.workspace.id), row]));

  return {
    account: account ? { id: account._id, name: account.name, status: account.status } : null,
    wallet: overview.wallet,
    totals: renewals.totals,
    workspaces: overview.workspaces.map((item) => {
      const renewal = renewalOf.get(String(item.workspace.id));
      const subscription = item.subscription;
      return {
        id: item.workspace.id,
        name: item.workspace.name,
        posType: item.workspace.vertical,
        posTypeLabel: labels.get(item.workspace.vertical) ?? item.workspace.vertical,
        status: item.workspace.status,
        isActive: item.isActive,
        /** No plan, or it has ended: choose one to use the POS. */
        needsPlan: !subscription || subscription.status === 'expired',
        subscription: subscription ? { planName: subscription.planName, planCode: subscription.planCode, billingCycle: subscription.billingCycle, status: subscription.status } : null,
        renewalDate: renewal?.nextRenewalAt ?? null,
        renewalAmountMinor: renewal?.renewalAmountMinor ?? null,
        currency: renewal?.currency ?? overview.upcoming.currency,
        renewsAutomatically: renewal?.renewsAutomatically ?? false,
        canRenewNow: renewal?.canRenewNow ?? false,
        attention: item.attention,
        /** Opening switches the session into it; the server checks ownership again then. */
        canOpen: item.workspace.status !== 'suspended' && account?.status !== 'suspended',
      };
    }),
    addPos: {
      canAdd: overview.workspaces.length < env.MAX_WORKSPACES_PER_ACCOUNT && account?.status !== 'suspended',
      maxWorkspaces: env.MAX_WORKSPACES_PER_ACCOUNT,
      options,
    },
  };
}
