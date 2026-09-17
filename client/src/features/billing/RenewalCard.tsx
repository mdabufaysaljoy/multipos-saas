import { useAuth } from '@/hooks/useAuth';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { AlertTriangle, CalendarClock, Repeat } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { PermissionGate } from '@/components/PermissionGate';
import { ApiError } from '@/api/client';
import { billingApi, renewalApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';

const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

/**
 * What happens when the current period ends: the next renewal's plan and
 * today's price for it, automatic renewal from the wallet, and any plan change
 * scheduled for then. Every figure and rule is the server's.
 */
export function RenewalCard() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['subscription', 'renewal'], queryFn: billingApi.renewal });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['subscription'] });
    void queryClient.invalidateQueries({ queryKey: ['plan-options'] });
  };

  const autoRenew = useMutation({
    mutationFn: (enabled: boolean) => billingApi.setAutoRenew(enabled),
    onSuccess: (info) => {
      toast.success(info.subscription?.autoRenew ? 'Automatic renewal is on' : 'Automatic renewal is off');
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not change automatic renewal')),
  });

  const cancelChange = useMutation({
    mutationFn: billingApi.cancelScheduledChange,
    onSuccess: () => {
      toast.success('Your current plan will renew as before');
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not cancel the scheduled change')),
  });

  const { can } = useAuth();
  const renewNow = useMutation({
    mutationFn: renewalApi.renewCurrent,
    onSuccess: (response) => {
      toast.success(`${response.billing.planName ?? 'Subscription'} renewed`);
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not renew the subscription')),
  });

  const subscription = data?.subscription;
  if (!subscription || !subscription.manageable) return null;

  const next = data.nextRenewal;
  const ended = new Date(subscription.currentPeriodEnd).getTime() <= Date.now();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Repeat className="h-4 w-4" />
          Renewal
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p>
              {ended ? 'Period ended' : 'Period ends'} <strong>{format(new Date(subscription.currentPeriodEnd), 'd MMMM yyyy')}</strong>
            </p>
            {next && (
              <p className="text-muted-foreground">
                Next: {next.name}
                {next.amountMinor !== null ? ` · ${formatMoney(next.amountMinor, next.currency)}` : ''}
                {!next.available && <span className="text-destructive"> · not available to buy right now</span>}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {data.renewalWindowOpen && !subscription.autoRenew && <Badge variant="warning">Renewal open</Badge>}
            {data.renewalWindowOpen && !subscription.cancelAtPeriodEnd && next?.available && can('subscription.manage') && can('wallet.manage') && (
              <Button size="sm" loading={renewNow.isPending} onClick={() => renewNow.mutate()}>
                Renew now{next.amountMinor !== null ? ` · ${formatMoney(next.amountMinor, next.currency)}` : ''}
              </Button>
            )}
          </div>
        </div>

        {data.scheduledChange && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-3">
            <div>
              <p className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 shrink-0" />
                Switching to <strong>{data.scheduledChange.planName}</strong> at renewal
              </p>
              {!data.scheduledChange.appliesAutomatically && (
                <p className="text-xs text-muted-foreground">Automatic renewal is off, so this change only applies if you renew.</p>
              )}
            </div>
            <PermissionGate anyOf={['subscription.manage']}>
              <Button size="sm" variant="outline" loading={cancelChange.isPending} onClick={() => cancelChange.mutate()}>
                Keep current plan
              </Button>
            </PermissionGate>
          </div>
        )}

        <PermissionGate anyOf={['subscription.manage']}>
          <label className="flex items-center justify-between gap-3 rounded-md border p-3">
            <span>
              Renew automatically from the wallet
              <span className="block text-xs text-muted-foreground">
                {subscription.cancelAtPeriodEnd
                  ? 'Resume the subscription to turn this on.'
                  : 'Charged at the price in effect on the renewal date. Keep enough balance in the wallet.'}
              </span>
            </span>
            <Switch
              checked={subscription.autoRenew && subscription.renewWith === 'wallet'}
              disabled={subscription.cancelAtPeriodEnd || autoRenew.isPending}
              onCheckedChange={(enabled) => autoRenew.mutate(enabled)}
              aria-label="Renew automatically from the wallet"
            />
          </label>
        </PermissionGate>

        {(subscription.failedRenewalAttempts > 0 || subscription.graceEndsAt) && (
          <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {subscription.failedRenewalAttempts > 0
                ? `Automatic renewal failed ${subscription.failedRenewalAttempts} time(s). Top up the wallet; it will try again.`
                : 'Payment is overdue. Automatic renewal will be tried shortly.'}
              {subscription.graceEndsAt && (
                <span className="block">The POS keeps working until {format(new Date(subscription.graceEndsAt), 'd MMMM yyyy, h:mm a')}.</span>
              )}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
