import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useSearchParams } from 'react-router-dom';
import { format } from 'date-fns';
import { AlertTriangle, Check, CreditCard, Info, Lock, Plus, RotateCcw, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { ApiError } from '@/api/client';
import { billingApi, type SubscriptionEventRow } from '@/api/endpoints';
import { DowngradeDialog } from '@/features/billing/DowngradeDialog';
import { UpgradeDialog } from '@/features/billing/UpgradeDialog';
import { RenewalCard } from '@/features/billing/RenewalCard';
import { formatPlanPrice } from '@/lib/money';
import { UsageMeter } from '@/components/UsageMeter';
import { evaluateUsage, usageLimitsFor } from '@/lib/usageLimits';
import { PlanComparisonTable } from '@/features/billing/PlanComparisonTable';
import { upgradeGains } from '@/lib/planCatalog';
import { FEATURE_LABELS } from '@/lib/planCatalog';
import type { PlanOption, SubscriptionPlan } from '@/types/domain';
import { VerifyContactCard } from '@/features/verification/VerifyContactCard';
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


const EVENT_LABELS: Record<string, string> = {
  created: 'Started',
  activated: 'Activated',
  extended: 'Extended',
  plan_changed: 'Plan changed',
  renewed: 'Renewed',
  renewal_failed: 'Renewal failed',
  cancelled: 'Cancelled',
  reactivated: 'Resumed',
  expired: 'Ended',
  suspended: 'Suspended',
  deactivated: 'Deactivated',
  refund_adjusted: 'Changed after refund',
};

/** What happened to this workspace's subscription, newest first, including changes made by support. */
function BillingActivity() {
  const { data, isLoading } = useQuery({ queryKey: ['subscription', 'history'], queryFn: billingApi.history });
  if (isLoading) return <LoadingState label="Loading billing activity…" />;
  const events = (data?.events ?? []) as SubscriptionEventRow[];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing activity</CardTitle>
        <CardDescription>Every change to your subscription, and why it happened.</CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>
        ) : (
          <ul className="divide-y">
            {events.map((event) => (
              <li key={event._id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant={event.type === 'refund_adjusted' || event.type === 'renewal_failed' ? 'warning' : 'secondary'}>
                      {EVENT_LABELS[event.type] ?? event.type}
                    </Badge>
                  </div>
                  <p className="mt-1 break-words text-sm">{event.message}</p>
                </div>
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={event.createdAt}>
                  {format(new Date(event.createdAt), 'd MMM yyyy, HH:mm')}
                </time>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function SubscriptionPage() {
  const queryClient = useQueryClient();
  const { refresh, session } = useAuth();
  const [interval, setInterval] = React.useState<'monthly' | 'yearly'>('monthly');
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [upgradePlan, setUpgradePlan] = React.useState<SubscriptionPlan | null>(null);
  // A downgrade opens the requirement panel first rather than being disabled.
  const [downgradePlan, setDowngradePlan] = React.useState<PlanOption | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['subscription', 'current'], queryFn: billingApi.current });
  // The server classifies every plan against the current one, so the cards and
  // the API can never disagree about what is allowed.
  const { data: planOptions } = useQuery({ queryKey: ['plan-options'], queryFn: billingApi.planOptions });
  // Shares the pricing page's cache; needed for the full plan definitions.
  const { data: publicPlans } = useQuery({ queryKey: ['public', 'plans'], queryFn: billingApi.plans });
  const { data: providers } = useQuery({ queryKey: ['payment-providers'], queryFn: billingApi.providers });
  const { data: payInfo } = useQuery({ queryKey: ['payment-instructions'], queryFn: billingApi.paymentInstructions });
  const { data: requests } = useQuery({ queryKey: ['upgrade-requests'], queryFn: billingApi.upgradeRequests });

  const pendingRequest = requests?.find((r) => r.status === 'pending') ?? null;

  // Returning from an online payment page. The server already confirmed the
  // result with the provider before redirecting; this only tells the customer.
  const [searchParams, setSearchParams] = useSearchParams();
  React.useEffect(() => {
    const result = searchParams.get('payment');
    if (!result) return;
    if (result === 'success') {
      toast.success('Payment confirmed', { description: 'Your plan is active.' });
      void refresh();
    } else if (result === 'pending') {
      toast.info('Payment not completed yet', {
        description: 'If money left your account, it will be confirmed automatically once bKash reports it.',
      });
    } else {
      toast.error('Payment was not accepted', {
        description: 'Nothing was activated. If you were charged, contact support with your bKash transaction ID.',
      });
    }
    void queryClient.invalidateQueries({ queryKey: ['subscription'] });
    const next = new URLSearchParams(searchParams);
    next.delete('payment');
    next.delete('ref');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, queryClient, refresh]);

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

  const scheduleChange = useMutation({
    mutationFn: (plan: PlanOption) => billingApi.scheduleChange({ plan: plan.catalogPlanCode!, billingCycle: plan.billingCycle! }),
    onSuccess: (result) => {
      toast.success(`${result.scheduledChange?.planName ?? 'The new plan'} starts at your next renewal`, {
        description: result.breaches.length > 0 ? 'Reduce your usage before then, or the renewal will not go through.' : undefined,
      });
      setDowngradePlan(null);
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not schedule the change'),
  });

  if (isLoading || !data) return <LoadingState label="Loading your plan…" />;

  const { entitlement, subscription, usage } = data;
  const status = STATUS_STYLE[entitlement.status] ?? { label: entitlement.status, variant: 'secondary' as const };
  const visiblePlans = (planOptions?.options ?? []).filter((plan) => plan.interval === interval);

  // Full plan objects for the comparison and the upgrade summaries. The
  // plan-options payload carries verdicts, not the whole plan.
  const allPlans = (publicPlans ?? []).filter((plan) => plan.interval === interval).sort((a, b) => a.tier - b.tier);
  const currentPlanFull = (publicPlans ?? []).find((plan) => plan.code === entitlement.planCode) ?? null;

  const upgradeTargets = currentPlanFull
    ? allPlans
        .filter((plan) => plan.tier > currentPlanFull.tier)
        .map((plan) => ({ plan, gains: upgradeGains(currentPlanFull, plan) }))
        .filter((entry) => entry.gains.length > 0)
    : [];
  const noOnlinePayments = (providers ?? []).length === 0;

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader title="Subscription" description="Your plan, usage and billing history." />

      {/* Buying needs one proven contact. Shown here so it can be done before
          the purchase rather than in the middle of it. */}
      {session?.user.verification && !session.user.verification.anyVerified && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Verify your contact</CardTitle>
            <CardDescription>
              Confirm your email address or phone number before buying a plan — that is where your invoices, receipts and
              renewal reminders go.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <VerifyContactCard />
          </CardContent>
        </Card>
      )}

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
                  ? `${formatPlanPrice(subscription.planSnapshot.priceMinor, subscription.planSnapshot.currency)} / ${subscription.planSnapshot.interval === 'yearly' ? 'year' : 'month'}`
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
                    Ended on <strong>{format(new Date(entitlement.currentPeriodEnd), 'd MMMM yyyy')}</strong>. Only
                    your wallet and this page are available until you activate a plan.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            {usageLimitsFor(usage.vertical).map((definition) => (
              <UsageMeter
                key={definition.limit}
                status={evaluateUsage(
                  definition,
                  (usage as unknown as Record<string, number>)[definition.usage] ?? 0,
                  (entitlement.limits as unknown as Record<string, number>)[definition.limit] ?? -1,
                )}
              />
            ))}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {Object.entries(entitlement.features).map(([key, enabled]) => (
              <Badge key={key} variant={enabled ? 'success' : 'secondary'}>
                {enabled ? <Check className="mr-1 h-3 w-3" /> : <Lock className="mr-1 h-3 w-3" />}
                {FEATURE_LABELS[key] ?? key}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <RenewalCard />

      {pendingRequest && (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="flex flex-wrap items-center gap-3 p-4 text-sm">
            <Badge variant="warning">Awaiting review</Badge>
            <span className="min-w-0 flex-1">
              Your upgrade to <strong>{pendingRequest.planSnapshot.name}</strong> is being verified
              (<span className="font-mono">{pendingRequest.transactionId}</span>). Your current plan stays active until
              it is approved.
            </span>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="plans">
        <TabsList>
          <TabsTrigger value="plans">Plans</TabsTrigger>
          <TabsTrigger value="activity">Billing activity</TabsTrigger>
        </TabsList>

        <TabsContent value="activity">
          <BillingActivity />
        </TabsContent>

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
            {visiblePlans.map((plan, _index, all) => {
              const analyticsPlans = [
                ...new Set(all.filter((p) => p.features.advancedReports).map((p) => p.name.replace(/ Annual$/, ''))),
              ].join(' & ');
              const isCurrent = plan.kind === 'current';
              // The plan the workspace was on, now lapsed - buying it again is
              // the way back in, so it must stay clickable.
              const isRenewal = plan.kind === 'renewal';
              const locked = plan.kind === 'downgrade' && plan.breaches.length > 0;
              return (
                <Card
                  key={plan.planId}
                  className={cn(
                    (isCurrent || isRenewal) && 'border-primary ring-1 ring-primary',
                    locked && 'opacity-75',
                  )}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{plan.name}</CardTitle>
                      {isCurrent && <Badge>Current</Badge>}
                      {isRenewal && <Badge variant="warning">Renew</Badge>}
                      {plan.kind === 'upgrade' && <Badge variant="success">Upgrade</Badge>}
                      {plan.kind === 'cycle-change' && <Badge variant="secondary">Switch to annual</Badge>}
                      {plan.kind === 'cycle-downgrade' && <Badge variant="warning">Cancel first</Badge>}
                      {plan.kind === 'downgrade' && <Badge variant="secondary">Downgrade</Badge>}
                    </div>
                    <CardDescription>
                      {plan.interval === 'yearly' ? 'Billed yearly' : 'Billed monthly'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="tabular text-2xl font-semibold">
                      {formatPlanPrice(plan.priceMinor, plan.currency)}
                      <span className="text-sm font-normal text-muted-foreground">
                        {' '}/ {plan.interval === 'yearly' ? 'year' : 'month'}
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
                      {!plan.features.advancedReports && (
                        <li className="flex items-start gap-1.5 text-muted-foreground">
                          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>
                            Advanced Analytics
                            <span className="block text-xs">Available on {analyticsPlans}</span>
                          </span>
                        </li>
                      )}
                    </ul>

                    <PermissionGate anyOf={['subscription.manage']}>
                      <Button
                        className="w-full"
                        variant={isCurrent || locked ? 'outline' : 'default'}
                        // The server rejects anything not `allowedDirect`, so the
                        // button must not imply otherwise.
                        disabled={isCurrent || Boolean(pendingRequest)}
                        onClick={() =>
                          // Downgrades open the requirement panel; everything
                          // else goes straight to payment.
                          plan.kind === 'downgrade'
                            ? setDowngradePlan(plan)
                            : setUpgradePlan({
                            _id: plan.planId,
                            code: plan.code,
                            name: plan.name,
                            description: '',
                            interval: plan.interval,
                            priceMinor: plan.priceMinor,
                            currency: plan.currency,
                            trialDays: 0,
                            features: plan.features,
                            limits: plan.limits,
                            isActive: true,
                            sortOrder: 0,
                                tier: plan.tier,
                              })
                        }
                      >
                        <CreditCard />
                        {isCurrent
                          ? 'Current plan'
                          : pendingRequest
                            ? 'Request pending'
                            : plan.kind === 'downgrade'
                              ? plan.breaches.length > 0
                                ? `Downgrade — ${plan.breaches[0].excess} ${plan.breaches[0].label} over limit`
                                : 'Downgrade'
                              : plan.kind === 'cycle-change'
                                ? 'Switch plan'
                                : isRenewal
                                  ? 'Renew plan'
                                  : 'Upgrade'}
                      </Button>
                    </PermissionGate>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* What each upgrade actually buys, derived from the plans rather
              than written by hand, so it cannot drift from what is enforced. */}
          {upgradeTargets.length > 0 && (
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              {upgradeTargets.map(({ plan, gains }) => (
                <Card key={plan._id} className="border-primary/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Sparkles className="h-4 w-4 text-primary" />
                      Upgrade to {plan.name.replace(/ Annual$/, '')}
                    </CardTitle>
                    <CardDescription>
                      {formatPlanPrice(plan.priceMinor, plan.currency)} / {plan.interval === 'yearly' ? 'year' : 'month'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-1 text-sm">
                      {gains.map((gain) => (
                        <li key={gain} className="flex items-start gap-2">
                          <Plus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                          <span>{gain}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* The same comparison a prospect sees on the public pricing page. */}
          {allPlans.length > 0 && (
            <section className="mt-8">
              <h2 className="text-lg font-semibold tracking-tight">Compare every plan</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Everything each plan includes, and everything it does not.
              </p>
              <div className="mt-4">
                <PlanComparisonTable plans={allPlans} currentPlanCode={entitlement.planCode} />
              </div>
            </section>
          )}
        </TabsContent>

      </Tabs>

      <DowngradeDialog
        plan={downgradePlan}
        currentPlanName={entitlement.planName}
        onClose={() => setDowngradePlan(null)}
        scheduling={scheduleChange.isPending}
        onSchedule={entitlement.isUsable ? (plan) => scheduleChange.mutate(plan) : undefined}
        onProceed={(plan) => {
          setDowngradePlan(null);
          setUpgradePlan({
            _id: plan.planId,
            code: plan.code,
            name: plan.name,
            description: '',
            interval: plan.interval,
            priceMinor: plan.priceMinor,
            currency: plan.currency,
            trialDays: 0,
            features: plan.features,
            limits: plan.limits,
            isActive: true,
            sortOrder: 0,
            tier: plan.tier,
            catalogPlanCode: plan.catalogPlanCode,
            billingCycle: plan.billingCycle,
          });
        }}
      />

      <UpgradeDialog
        plan={upgradePlan}
        currentPlanName={entitlement.planName}
        instructions={payInfo?.instructions ?? []}
        onClose={() => setUpgradePlan(null)}
      />

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


