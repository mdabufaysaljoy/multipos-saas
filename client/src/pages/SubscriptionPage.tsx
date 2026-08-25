import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { AlertTriangle, Check, CreditCard, Info, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { ApiError } from '@/api/client';
import { billingApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

const STATUS_STYLE: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  active: { label: 'Active', variant: 'success' },
  trial: { label: 'Trial', variant: 'warning' },
  past_due: { label: 'Payment overdue', variant: 'warning' },
  cancelled: { label: 'Cancelling', variant: 'warning' },
  expired: { label: 'Expired', variant: 'destructive' },
  suspended: { label: 'Suspended', variant: 'destructive' },
};

const FEATURE_LABELS: Record<string, string> = {
  salesReports: 'Sales reports',
  advancedReports: 'Advanced analytics',
  customerManagement: 'Customer management',
  inventoryLedger: 'Inventory ledger',
  multiStore: 'Multiple stores',
  customRoles: 'Custom roles',
  exportData: 'Data export',
  prioritySupport: 'Priority support',
};

export function SubscriptionPage() {
  const queryClient = useQueryClient();
  const { refresh } = useAuth();
  const [interval, setInterval] = React.useState<'monthly' | 'yearly'>('monthly');
  const [cancelOpen, setCancelOpen] = React.useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['subscription', 'current'], queryFn: billingApi.current });
  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: billingApi.plans });
  const { data: history } = useQuery({ queryKey: ['subscription', 'history'], queryFn: billingApi.history });
  const { data: providers } = useQuery({ queryKey: ['payment-providers'], queryFn: billingApi.providers });

  const cancel = useMutation({
    mutationFn: () => billingApi.cancel({ immediate: false }),
    onSuccess: () => {
      toast.success('Subscription cancelled', {
        description: 'You keep full access until the end of the period you have paid for.',
      });
      setCancelOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
      void refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not cancel'),
  });

  const reactivate = useMutation({
    mutationFn: () => billingApi.reactivate(),
    onSuccess: () => {
      toast.success('Subscription resumed');
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
      void refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not resume'),
  });

  if (isLoading || !data) return <LoadingState label="Loading your plan…" />;

  const { entitlement, subscription, usage } = data;
  const status = STATUS_STYLE[entitlement.status] ?? { label: entitlement.status, variant: 'secondary' as const };
  const visiblePlans = (plans ?? []).filter((plan) => plan.interval === interval);
  const noOnlinePayments = (providers ?? []).length === 0;

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader title="Subscription" description="Your plan, usage and billing history." />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                {entitlement.planName ?? 'No plan'}
                <Badge variant={status.variant}>{status.label}</Badge>
              </CardTitle>
              <CardDescription>
                {subscription
                  ? `${formatMoney(subscription.planSnapshot.priceMinor, subscription.planSnapshot.currency)} / ${subscription.planSnapshot.interval === 'yearly' ? 'year' : 'month'}`
                  : 'Contact support to activate a plan.'}
              </CardDescription>
            </div>

            <PermissionGate anyOf={['subscription.manage']}>
              <div className="flex gap-2">
                {entitlement.cancelAtPeriodEnd ? (
                  <Button variant="outline" loading={reactivate.isPending} onClick={() => reactivate.mutate()}>
                    <RotateCcw />
                    Resume subscription
                  </Button>
                ) : (
                  entitlement.isUsable && (
                    <Button variant="outline" onClick={() => setCancelOpen(true)}>
                      Cancel subscription
                    </Button>
                  )
                )}
              </div>
            </PermissionGate>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {entitlement.currentPeriodEnd && (
            <div
              className={cn(
                'flex items-start gap-2 rounded-md border p-3 text-sm',
                entitlement.isUsable
                  ? 'border-border bg-muted/40'
                  : 'border-destructive/30 bg-destructive/5 text-destructive',
              )}
            >
              {entitlement.isUsable ? <Info className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
              <div>
                {entitlement.cancelAtPeriodEnd ? (
                  <p>
                    Cancelled. You keep full access until{' '}
                    <strong>{format(new Date(entitlement.currentPeriodEnd), 'd MMMM yyyy')}</strong>, then the
                    subscription ends. Nothing will be charged again.
                  </p>
                ) : entitlement.isUsable ? (
                  <p>
                    Renews on <strong>{format(new Date(entitlement.currentPeriodEnd), 'd MMMM yyyy')}</strong> —{' '}
                    {entitlement.daysRemaining} day{entitlement.daysRemaining === 1 ? '' : 's'} remaining.
                  </p>
                ) : (
                  <p>
                    Ended on <strong>{format(new Date(entitlement.currentPeriodEnd), 'd MMMM yyyy')}</strong>. You can
                    still read your data, but new sales and edits are blocked.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <UsageBar label="Products" used={usage.products} limit={entitlement.limits.maxProducts} />
            <UsageBar label="Staff accounts" used={usage.staff} limit={entitlement.limits.maxStaff} />
            <UsageBar label="Stores" used={usage.stores} limit={entitlement.limits.maxStores} />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {Object.entries(entitlement.features).map(([key, enabled]) => (
              <Badge key={key} variant={enabled ? 'success' : 'secondary'}>
                {enabled ? <Check className="mr-1 h-3 w-3" /> : null}
                {FEATURE_LABELS[key] ?? key}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="plans">
        <TabsList>
          <TabsTrigger value="plans">Plans</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="plans" className="space-y-4">
          <div className="flex items-center gap-2">
            <Button variant={interval === 'monthly' ? 'default' : 'outline'} size="sm" onClick={() => setInterval('monthly')}>
              Monthly
            </Button>
            <Button variant={interval === 'yearly' ? 'default' : 'outline'} size="sm" onClick={() => setInterval('yearly')}>
              Yearly
              <Badge variant="success" className="ml-1">2 months free</Badge>
            </Button>
          </div>

          {noOnlinePayments && (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                Online payment through bKash, Nagad or a bank gateway is not enabled on this server yet. To change your
                plan, contact support and an administrator will activate it for you.
              </p>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-3">
            {visiblePlans.map((plan) => {
              const isCurrent = subscription?.planSnapshot.code === plan.code;
              return (
                <Card key={plan._id} className={cn(isCurrent && 'border-primary ring-1 ring-primary')}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{plan.name}</CardTitle>
                      {isCurrent && <Badge>Current</Badge>}
                    </div>
                    <CardDescription>{plan.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="tabular text-2xl font-semibold">
                      {formatMoney(plan.priceMinor, plan.currency)}
                      <span className="text-sm font-normal text-muted-foreground">
                        /{plan.interval === 'yearly' ? 'year' : 'month'}
                      </span>
                    </p>

                    <ul className="space-y-1 text-sm">
                      <LimitRow label="Products" value={plan.limits.maxProducts} />
                      <LimitRow label="Staff accounts" value={plan.limits.maxStaff} />
                      <LimitRow label="Stores" value={plan.limits.maxStores} />
                    </ul>

                    <ul className="space-y-1 border-t pt-3 text-sm">
                      {Object.entries(plan.features)
                        .filter(([, enabled]) => enabled)
                        .map(([key]) => (
                          <li key={key} className="flex items-center gap-1.5 text-muted-foreground">
                            <Check className="h-3.5 w-3.5 text-success" />
                            {FEATURE_LABELS[key] ?? key}
                          </li>
                        ))}
                    </ul>

                    <PermissionGate anyOf={['subscription.manage']}>
                      <Button
                        className="w-full"
                        variant={isCurrent ? 'outline' : 'default'}
                        disabled={isCurrent || noOnlinePayments}
                        onClick={() =>
                          toast.info('Contact support to switch plans', {
                            description: 'Online checkout is not enabled on this server yet.',
                          })
                        }
                      >
                        <CreditCard />
                        {isCurrent ? 'Current plan' : 'Choose plan'}
                      </Button>
                    </PermissionGate>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Subscription history</CardTitle>
            </CardHeader>
            <CardContent>
              {(history?.events?.length ?? 0) === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No history yet</p>
              ) : (
                <ul className="divide-y">
                  {(history?.events as { _id: string; type: string; message: string; createdAt: string; actorNameSnapshot: string }[]).map(
                    (event) => (
                      <li key={event._id} className="flex items-start gap-3 py-2.5 first:pt-0">
                        <Badge variant="secondary" className="mt-0.5 shrink-0">
                          {event.type.replace(/_/g, ' ')}
                        </Badge>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm">{event.message}</p>
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(event.createdAt), 'd MMM yyyy, hh:mm a')} · {event.actorNameSnapshot}
                          </p>
                        </div>
                      </li>
                    ),
                  )}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel your subscription?"
        description={
          <span>
            You will keep full access until{' '}
            <strong>
              {entitlement.currentPeriodEnd ? format(new Date(entitlement.currentPeriodEnd), 'd MMMM yyyy') : 'the end of the period'}
            </strong>
            . Nothing will be charged after that, and you can resume any time before it ends.
          </span>
        }
        confirmLabel="Cancel subscription"
        cancelLabel="Keep my plan"
        destructive
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
    </div>
  );
}

function LimitRow({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular font-medium">{value === -1 ? 'Unlimited' : value}</span>
    </li>
  );
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const unlimited = limit === -1;
  const percent = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const near = !unlimited && percent >= 80;

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="tabular text-sm font-semibold">
          {used}
          <span className="font-normal text-muted-foreground">/{unlimited ? '∞' : limit}</span>
        </span>
      </div>
      {!unlimited && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-all', near ? 'bg-warning' : 'bg-primary')}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}
