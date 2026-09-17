import { TopUpDialog } from '@/features/billing/TopUpDialog';
import { AccountWalletPanel } from '@/features/billing/AccountWalletPanel';
import { ChangePlanDialog } from '@/features/billing/ChangePlanDialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import * as React from 'react';
import { StatementPanel } from '@/features/billing/StatementPanel';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, CalendarClock, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { ApiError } from '@/api/client';
import { accountApi, type AccountBilling, type BillingAttention, type WorkspaceBillingItem, accountBillingActionsApi, renewalApi } from '@/api/endpoints';
import { useAuth } from '@/hooks/useAuth';
import { InvoicesPanel } from '@/features/billing/InvoicesPanel';
import { PaymentsPanel } from '@/features/billing/PaymentsPanel';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

type BadgeVariant = 'success' | 'warning' | 'destructive' | 'secondary';

const STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  active: { label: 'Active', variant: 'success' },
  trialing: { label: 'Trial', variant: 'warning' },
  past_due: { label: 'Payment overdue', variant: 'warning' },
  cancelled: { label: 'Cancelling', variant: 'warning' },
  expired: { label: 'Expired', variant: 'destructive' },
  suspended: { label: 'Suspended', variant: 'destructive' },
};

const VERTICAL_LABEL: Record<string, string> = {
  clothing: 'Clothing',
  restaurant: 'Restaurant',
  pharmacy: 'Pharmacy',
  supershop: 'Super shop',
  grocery: 'Grocery',
};

const ATTENTION_TEXT: Record<BillingAttention, string> = {
  suspended: 'This workspace is suspended. Contact support.',
  no_subscription: 'No plan yet. Choose one to start using this workspace.',
  expired: 'The subscription has ended. Renew to use the POS again.',
  in_grace: 'Payment is overdue. The POS keeps working for now while renewal is retried.',
  renewal_failed: 'Automatic renewal failed. Top up the wallet; it will try again.',
  cancelling: 'Cancelled: access ends when the current period ends.',
  trial_ending: 'The free trial ends in a few days.',
  wallet_short: 'The wallet will not cover this renewal. Top up before it is due.',
};

const BILLING_KEY = ['account', 'billing'] as const;
const day = (value: string | null | undefined) => (value ? format(new Date(value), 'd MMM yyyy') : '—');
const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

/**
 * The account billing center: every workspace's subscription on its own, the
 * shared wallet with its transactions and spending by service, invoices,
 * payments and the statement. Only the account owner reaches it; every figure
 * and every rule (plan changes, cancellation, renewal) is the server's.
 */
export function BillingOverviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const tab = (['subscriptions', 'wallet', 'invoices', 'payments', 'statement'] as const).find((name) => name === requested) ?? 'overview';
  const { data, isLoading, isError } = useQuery({ queryKey: BILLING_KEY, queryFn: accountApi.billing });

  if (isLoading) return <LoadingState label="Loading billing…" />;
  if (isError || !data) {
    return (
      <div className="p-6">
        <EmptyState title="Could not load billing" description="Only the account owner can see billing across workspaces." />
      </div>
    );
  }

  const workspaceOptions = data.workspaces.map((item) => ({ id: String(item.workspace.id), name: item.workspace.name }));

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader title="Billing" description="Every workspace's subscription, paid from one shared account wallet." />
      <Tabs value={tab} onValueChange={(value) => setSearchParams(value === 'overview' ? {} : { tab: value }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
          <TabsTrigger value="wallet">Wallet</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="statement">Statement</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-5">
          <Summary data={data} />
          <SubscriptionsTable data={data} />
          <UpcomingRenewals data={data} />
        </TabsContent>

        <TabsContent value="wallet" className="space-y-5">
          <TopUpSection workspaces={workspaceOptions} />
          <AccountWalletPanel workspaces={workspaceOptions} />
        </TabsContent>

        <TabsContent value="subscriptions" className="space-y-5">
          {data.workspaces.length === 0 ? (
            <EmptyState title="No workspaces yet" />
          ) : (
            <div className="space-y-3">
              {data.workspaces.map((item) => (
                <WorkspaceBillingCard key={String(item.workspace.id)} item={item} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="invoices">
          <InvoicesPanel workspaces={workspaceOptions} />
        </TabsContent>

        <TabsContent value="payments">
          <PaymentsPanel workspaces={workspaceOptions} />
        </TabsContent>

        <TabsContent value="statement">
          <StatementPanel workspaces={workspaceOptions} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Summary({ data }: { data: AccountBilling }) {
  const currency = data.wallet?.currency ?? data.upcoming.currency;
  const short = data.upcoming.shortfallMinor > 0;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <SummaryCard
        label="Wallet balance"
        value={data.wallet ? formatMoney(data.wallet.balanceMinor, data.wallet.currency) : '—'}
        hint={data.wallet?.isFrozen ? 'Frozen. Contact support.' : 'Shared by all your workspaces'}
        warn={Boolean(data.wallet?.isFrozen)}
      />
      <SummaryCard
        label={`Renewing in the next ${data.upcoming.windowDays} days`}
        value={formatMoney(data.upcoming.dueMinor, currency)}
        hint={short ? `Top up ${formatMoney(data.upcoming.shortfallMinor, currency)} to cover them` : 'Covered by the wallet'}
        warn={short}
      />
      <SummaryCard
        label="Workspaces"
        value={`${data.totals.active} of ${data.totals.workspaces} active`}
        hint={data.totals.needsAttention > 0 ? `${data.totals.needsAttention} need attention` : 'Nothing needs attention'}
        warn={data.totals.needsAttention > 0}
      />
    </div>
  );
}

function SummaryCard({ label, value, hint, warn }: { label: string; value: string; hint: string; warn?: boolean }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold tabular-nums">{value}</p>
        <p className={cn('text-xs', warn ? 'text-destructive' : 'text-muted-foreground')}>{hint}</p>
      </CardContent>
    </Card>
  );
}

/** Every workspace's subscription on its own line: POS type, plan, price per cycle, status. */
function SubscriptionsTable({ data }: { data: AccountBilling }) {
  if (data.workspaces.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Subscriptions</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="pb-2 font-medium">Workspace</th>
              <th className="pb-2 font-medium">Plan</th>
              <th className="pb-2 text-right font-medium">Price</th>
              <th className="pb-2 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.workspaces.map((item) => {
              const subscription = item.subscription;
              const status = subscription ? (STATUS[subscription.status] ?? { label: subscription.status, variant: 'secondary' as const }) : { label: 'No plan', variant: 'secondary' as const };
              return (
                <tr key={String(item.workspace.id)} className="border-t">
                  <td className="py-2">
                    <span className="font-medium">{item.workspace.posTypeLabel ?? VERTICAL_LABEL[item.workspace.vertical] ?? item.workspace.vertical} POS</span>
                    <span className="block text-xs text-muted-foreground">{item.workspace.name}</span>
                  </td>
                  <td className="py-2">{subscription ? (subscription.planName ?? subscription.planCode ?? '—') : '—'}</td>
                  <td className="py-2 text-right tabular-nums">
                    {subscription?.priceMinor != null && subscription.status !== 'trialing'
                      ? `${formatMoney(subscription.priceMinor, subscription.currency ?? 'BDT')}/${subscription.billingCycle === 'annual' ? 'year' : 'month'}`
                      : subscription?.status === 'trialing'
                        ? 'Free trial'
                        : '—'}
                  </td>
                  <td className="py-2 text-right">
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function UpcomingRenewals({ data }: { data: AccountBilling }) {
  if (data.upcoming.renewals.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Automatic renewals coming up</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="pb-2 font-medium">Date</th>
              <th className="pb-2 font-medium">Workspace</th>
              <th className="pb-2 font-medium">Plan</th>
              <th className="pb-2 text-right font-medium">Amount</th>
              <th className="pb-2 text-right font-medium">Wallet</th>
            </tr>
          </thead>
          <tbody>
            {data.upcoming.renewals.map((row) => (
              <tr key={String(row.workspaceId)} className="border-t">
                <td className="py-2">{row.overdue ? <span className="text-destructive">Overdue</span> : day(row.renewsAt)}</td>
                <td className="py-2">{row.workspaceName}</td>
                <td className="py-2">
                  {row.planName} · {row.billingCycle === 'annual' ? 'Annual' : 'Monthly'}
                </td>
                <td className="py-2 text-right tabular-nums">{formatMoney(row.amountMinor, row.currency)}</td>
                <td className="py-2 text-right">
                  <Badge variant={row.coveredByWallet ? 'success' : 'destructive'}>{row.coveredByWallet ? 'Covered' : 'Short'}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function WorkspaceBillingCard({ item }: { item: WorkspaceBillingItem }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { session, switchWorkspace } = useAuth();
  const id = String(item.workspace.id);
  const isCurrent = session?.tenant?.id === id;

  const done = (message: string) => {
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: BILLING_KEY });
    if (isCurrent) void queryClient.invalidateQueries({ queryKey: ['subscription'] });
  };

  const autoRenew = useMutation({
    mutationFn: (enabled: boolean) => accountApi.setAutoRenew(id, enabled),
    onSuccess: (updated) => done(updated.renewal.renewsAutomatically ? 'Automatic renewal is on' : 'Automatic renewal is off'),
    onError: (error) => toast.error(errorMessage(error, 'Could not change automatic renewal')),
  });
  const withdraw = useMutation({
    mutationFn: () => accountApi.cancelScheduledChange(id),
    onSuccess: () => done('The current plan will renew as before'),
    onError: (error) => toast.error(errorMessage(error, 'Could not withdraw the change')),
  });
  const reactivate = useMutation({
    mutationFn: () => accountApi.reactivate(id),
    onSuccess: () => done('Subscription resumed'),
    onError: (error) => toast.error(errorMessage(error, 'Could not resume the subscription')),
  });
  const renew = useMutation({
    mutationFn: () => renewalApi.renewWorkspace(id),
    onSuccess: (response) =>
      done(
        `${response.billing.planName ?? 'Subscription'} renewed${response.billing.walletBalanceMinor !== null && response.billing.currency ? ` · wallet ${formatMoney(response.billing.walletBalanceMinor, response.billing.currency)}` : ''}`,
      ),
    onError: (error) => toast.error(errorMessage(error, 'Could not renew the subscription')),
  });
  // Opening the workspace itself (its own subscription page has the other payment methods).
  const manage = useMutation({
    mutationFn: async () => {
      if (!isCurrent) await switchWorkspace(id);
    },
    onSuccess: () => navigate('/subscription'),
    onError: (error) => toast.error(errorMessage(error, 'Could not open this workspace')),
  });

  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [changeOpen, setChangeOpen] = React.useState(false);

  const subscription = item.subscription;
  const renewal = item.renewal;
  const status = subscription ? (STATUS[subscription.status] ?? { label: subscription.status, variant: 'secondary' as const }) : { label: 'No plan', variant: 'secondary' as const };
  const ended = subscription ? new Date(subscription.currentPeriodEnd).getTime() <= Date.now() : false;
  const suspended = item.attention.includes('suspended');

  const periodLabel = !subscription
    ? null
    : subscription.status === 'trialing'
      ? 'Trial ends'
      : ended
        ? 'Period ended'
        : subscription.cancelAtPeriodEnd
          ? 'Access ends'
          : renewal.renewsAutomatically
            ? 'Renews'
            : 'Period ends';

  const attentionText = (reason: BillingAttention) => {
    if (reason === 'in_grace' && renewal.graceEndsAt) {
      return `Payment is overdue. The POS keeps working until ${format(new Date(renewal.graceEndsAt), 'd MMM yyyy, h:mm a')} while renewal is retried.`;
    }
    if (reason === 'renewal_failed') return `Automatic renewal failed ${renewal.failedRenewalAttempts} time(s). Top up the wallet; it will try again.`;
    return ATTENTION_TEXT[reason];
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              <span className="truncate">{item.workspace.name}</span>
              <Badge variant="secondary">{item.workspace.posTypeLabel ?? VERTICAL_LABEL[item.workspace.vertical] ?? item.workspace.vertical}</Badge>
              <Badge variant={status.variant}>{status.label}</Badge>
              {isCurrent && <span className="text-xs font-normal text-muted-foreground">(you are here)</span>}
            </p>
            <p className="text-sm text-muted-foreground">
              {subscription
                ? `${subscription.planName ?? subscription.planCode ?? 'Plan'} · ${subscription.billingCycle === 'annual' ? 'Annual' : 'Monthly'}${
                    subscription.priceMinor !== null ? ` · ${formatMoney(subscription.priceMinor, subscription.currency ?? 'BDT')}` : ''
                  }`
                : 'No plan'}
            </p>
            {subscription && (
              <p className="text-sm">
                {periodLabel} <strong>{day(subscription.currentPeriodEnd)}</strong>
                {renewal.renewsAutomatically && renewal.nextRenewal?.amountMinor != null && !subscription.cancelAtPeriodEnd
                  ? ` · ${renewal.nextRenewal.name} at ${formatMoney(renewal.nextRenewal.amountMinor, renewal.nextRenewal.currency)}`
                  : ''}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {subscription &&
              !suspended &&
              !subscription.cancelAtPeriodEnd &&
              renewal.nextRenewal?.available &&
              (renewal.renewalWindowOpen || ended) && (
                <Button size="sm" loading={renew.isPending} onClick={() => renew.mutate()}>
                  Renew now
                  {renewal.nextRenewal.amountMinor !== null ? ` · ${formatMoney(renewal.nextRenewal.amountMinor, renewal.nextRenewal.currency)}` : ''}
                </Button>
              )}
            {subscription && !suspended && !subscription.cancelAtPeriodEnd && ['active', 'trialing', 'past_due'].includes(subscription.status) && (
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setCancelOpen(true)}>
                Cancel subscription
              </Button>
            )}
            {!suspended && (!subscription || !subscription.cancelAtPeriodEnd) && (
              <Button size="sm" variant="outline" onClick={() => setChangeOpen(true)}>
                {subscription ? 'Change plan' : 'Choose a plan'}
              </Button>
            )}
            <Button size="sm" variant="ghost" loading={manage.isPending} disabled={suspended} onClick={() => manage.mutate()}>
              Open workspace
              <ArrowRight />
            </Button>
          </div>
        </div>

        {item.attention.length > 0 && (
          <ul className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {item.attention.map((reason) => (
              <li key={reason} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {attentionText(reason)}
              </li>
            ))}
          </ul>
        )}

        {renewal.scheduledChange && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-3 text-sm">
            <div>
              <p className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 shrink-0" />
                Switching to <strong>{renewal.scheduledChange.planName}</strong> at renewal
              </p>
              {!renewal.scheduledChange.appliesAutomatically && (
                <p className="text-xs text-muted-foreground">Automatic renewal is off, so this change only applies if you renew.</p>
              )}
            </div>
            <Button size="sm" variant="outline" loading={withdraw.isPending} disabled={suspended} onClick={() => withdraw.mutate()}>
              Keep current plan
            </Button>
          </div>
        )}

        {subscription && !suspended && subscription.cancelAtPeriodEnd && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
            <span>{ended ? 'Cancelled, and the period has ended.' : `Cancelled. Resume to keep this plan after ${day(subscription.currentPeriodEnd)}.`}</span>
            {!ended && (
              <Button size="sm" loading={reactivate.isPending} onClick={() => reactivate.mutate()}>
                Resume
              </Button>
            )}
          </div>
        )}

        {subscription && !suspended && !subscription.cancelAtPeriodEnd && renewal.manageable && (
          <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
            <span>
              Renew automatically from the wallet
              <span className="block text-xs text-muted-foreground">Charged at the price in effect on the renewal date.</span>
            </span>
            <Switch
              checked={renewal.renewsAutomatically}
              disabled={autoRenew.isPending}
              onCheckedChange={(enabled) => autoRenew.mutate(enabled)}
              aria-label={`Renew ${item.workspace.name} automatically`}
            />
          </label>
        )}
      </CardContent>
      <ChangePlanDialog
        workspace={
          changeOpen
            ? {
                id,
                name: item.workspace.name,
                planCode: subscription && subscription.status !== 'expired' ? (subscription.planCode ?? null) : null,
                billingCycle: subscription ? (subscription.billingCycle === 'annual' ? 'annual' : 'monthly') : null,
              }
            : null
        }
        onClose={() => setChangeOpen(false)}
        onDone={() => {
          if (isCurrent) void queryClient.invalidateQueries({ queryKey: ['subscription'] });
        }}
      />
      {subscription && (
        <CancelSubscriptionDialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          workspaceId={id}
          workspaceName={item.workspace.name}
          periodEnd={subscription.currentPeriodEnd}
          isTrial={subscription.status === 'trialing'}
          onDone={() => done('Subscription cancelled')}
        />
      )}
    </Card>
  );
}

/** Adding money to the shared wallet, and the requests still waiting for verification. */
function TopUpSection({ workspaces }: { workspaces: { id: string; name: string }[] }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const { data: payInfo } = useQuery({ queryKey: ['account', 'payment-instructions'], queryFn: accountBillingActionsApi.paymentInstructions });
  const { data: pending } = useQuery({
    queryKey: ['account', 'top-ups', 'pending'],
    queryFn: () => accountBillingActionsApi.topUps({ status: 'pending', limit: 20 }),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['account'] });
    void queryClient.invalidateQueries({ queryKey: ['wallet'] });
  };
  const cancel = useMutation({
    mutationFn: (id: string) => accountBillingActionsApi.cancelTopUp(id),
    onSuccess: () => {
      toast.success('Top-up request cancelled');
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not cancel the request')),
  });

  const requests = pending?.items ?? [];

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-medium">Add money</p>
            <p className="text-xs text-muted-foreground">Top up the wallet all your workspaces share. It is credited once the payment is verified.</p>
          </div>
          <Button size="sm" onClick={() => setOpen(true)} disabled={(payInfo?.instructions.length ?? 0) === 0}>
            <Plus />
            Add money
          </Button>
        </div>

        {requests.length > 0 && (
          <ul className="divide-y rounded-md border">
            {requests.map((request) => (
              <li key={request.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                <Badge variant="warning">Awaiting verification</Badge>
                <span className="tabular-nums font-medium">{formatMoney(request.amountMinor, request.currency)}</span>
                <span className="text-muted-foreground">
                  via {request.paymentMethod} · <span className="font-mono">{request.transactionId}</span>
                  {request.workspaceName ? ` · ${request.workspaceName}` : ''} · {day(request.createdAt)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  loading={cancel.isPending && cancel.variables === request.id}
                  onClick={() => cancel.mutate(request.id)}
                >
                  Cancel request
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <TopUpDialog
        open={open}
        onOpenChange={setOpen}
        instructions={payInfo?.instructions ?? []}
        workspaces={workspaces}
        submit={(body) => accountBillingActionsApi.requestTopUp(body)}
        onDone={refresh}
      />
    </Card>
  );
}

/**
 * Cancelling one workspace's subscription. By default it runs to the end of
 * the period already paid for; ending access now is a deliberate choice.
 */
function CancelSubscriptionDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  periodEnd,
  isTrial,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  periodEnd: string;
  isTrial: boolean;
  onDone: () => void;
}) {
  const [immediate, setImmediate] = React.useState(false);
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setImmediate(false);
      setReason('');
    }
  }, [open]);

  const cancel = useMutation({
    mutationFn: () => accountBillingActionsApi.cancelSubscription(workspaceId, { immediate, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    onSuccess: () => {
      onOpenChange(false);
      onDone();
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not cancel the subscription')),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !cancel.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel the subscription for {workspaceName}?</DialogTitle>
          <DialogDescription>
            {immediate
              ? 'The POS in this workspace stops working straight away. Nothing is refunded.'
              : `It will not renew. The workspace keeps working until ${day(periodEnd)}${isTrial ? ', when the trial ends' : ''}.`}{' '}
            Your other workspaces are not affected, and your data is kept.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={immediate} onCheckedChange={(value) => setImmediate(value === true)} aria-label="End access immediately" />
            <span>
              End access immediately
              <span className="block text-xs text-muted-foreground">Instead of at the end of the period already paid for.</span>
            </span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor={`cancel-reason-${workspaceId}`}>Reason (optional)</Label>
            <Textarea id={`cancel-reason-${workspaceId}`} value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} rows={3} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={cancel.isPending}>
            Keep subscription
          </Button>
          <Button variant="destructive" loading={cancel.isPending} onClick={() => cancel.mutate()}>
            {immediate ? 'Cancel now' : 'Cancel at period end'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
