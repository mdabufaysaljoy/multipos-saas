import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, LoadingState } from '@/components/states';
import { ApiError } from '@/api/client';
import { accountApi, onboardingApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

type Cycle = 'monthly' | 'annual';

const KIND_TEXT: Record<string, string> = {
  upgrade: 'Upgrade: starts now. Unused time on the current plan is credited.',
  'cycle-change': 'Billing cycle change: starts now. Unused time on the current plan is credited.',
  downgrade: 'Downgrade: usually best scheduled for the next renewal, so no paid time is lost.',
  renewal: 'Renewal of the current plan.',
};

const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);
const newKey = () => `chg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Changing ONE workspace's plan or billing cycle from the account billing
 * page. Every figure and every rule is the server's: the quote carries the
 * transition kind and the price, paying now goes through checkout (which
 * re-prices and refuses a changed price), and scheduling goes through the
 * renewal service. A move the rules refuse is shown, never worked around.
 */
export function ChangePlanDialog({
  workspace,
  onClose,
  onDone,
}: {
  workspace: { id: string; name: string; planCode: string | null; billingCycle: Cycle | null } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [plan, setPlan] = React.useState('');
  const [billingCycle, setBillingCycle] = React.useState<Cycle>('monthly');
  const [operationKey, setOperationKey] = React.useState(newKey);

  const options = useQuery({ queryKey: ['workspace-plans', workspace?.id], queryFn: () => onboardingApi.plans(workspace!.id), enabled: Boolean(workspace) });

  React.useEffect(() => {
    if (!workspace) return;
    setBillingCycle(workspace.billingCycle ?? 'monthly');
    setPlan('');
    setOperationKey(newKey());
  }, [workspace]);

  const plans = options.data?.catalog.plans ?? [];
  const available = plans.filter((option) => (billingCycle === 'annual' ? option.annual : option.monthly));
  React.useEffect(() => {
    if (!plan && available[0]) setPlan(available[0].code);
  }, [available, plan]);

  const quote = useQuery({
    queryKey: ['workspace-quote', workspace?.id, plan, billingCycle],
    queryFn: () => onboardingApi.quote(workspace!.id, { plan, billingCycle }),
    enabled: Boolean(workspace && plan),
    retry: false,
  });

  const finish = (message: string) => {
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: ['account'] });
    onDone();
    onClose();
  };

  const payNow = useMutation({
    mutationFn: () => onboardingApi.checkoutFromWallet(workspace!.id, { plan, billingCycle, idempotencyKey: operationKey, expectedPayableMinor: quote.data!.payableMinor }),
    onSuccess: () => finish(`${workspace?.name} is now on ${quote.data?.plan.name}`),
    onError: (error) => {
      if (error instanceof ApiError && (error.details as { reason?: string } | undefined)?.reason === 'PRICE_CHANGED') {
        toast.warning('The price changed. Please review the new price.');
        setOperationKey(newKey());
        void quote.refetch();
        return;
      }
      toast.error(errorMessage(error, 'Could not change the plan'));
    },
  });

  const schedule = useMutation({
    mutationFn: () => accountApi.scheduleChange(workspace!.id, { plan, billingCycle }),
    onSuccess: (result) => {
      if (result.change.breaches.length > 0) toast.warning('Reduce usage to fit the new plan before the renewal date, or the change cannot apply.');
      finish(`The change is scheduled for ${workspace?.name}'s next renewal`);
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not schedule the change')),
  });

  const kind = quote.data?.transition.kind;
  const isCurrent = workspace?.planCode !== null && quote.isError && !kind;
  const busy = payNow.isPending || schedule.isPending;

  return (
    <Dialog open={Boolean(workspace)} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Change plan · {workspace?.name}</DialogTitle>
          <DialogDescription>Prices are for this workspace's POS type. The change applies to this workspace only.</DialogDescription>
        </DialogHeader>

        {options.isLoading ? (
          <LoadingState label="Loading plans…" />
        ) : options.isError || plans.length === 0 ? (
          <EmptyState title="Plans are not available right now" />
        ) : (
          <div className="space-y-4">
            <div className="flex gap-2" role="radiogroup" aria-label="Billing cycle">
              {(['monthly', 'annual'] as const).map((cycle) => (
                <Button key={cycle} size="sm" variant={billingCycle === cycle ? 'default' : 'outline'} onClick={() => setBillingCycle(cycle)} disabled={busy}>
                  {cycle === 'monthly' ? 'Monthly' : 'Annual'}
                </Button>
              ))}
            </div>
            <div className="grid gap-2" role="radiogroup" aria-label="Plan">
              {available.map((option) => (
                <label key={option.code} className={cn('cursor-pointer rounded-md border p-3 text-sm', plan === option.code && 'border-primary ring-1 ring-primary')}>
                  <input type="radio" name="change-plan" className="sr-only" value={option.code} checked={plan === option.code} onChange={() => setPlan(option.code)} />
                  <span className="font-medium">{option.displayName}</span>
                  {option.description && <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>}
                </label>
              ))}
            </div>
            <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
              {quote.isLoading ? (
                'Pricing…'
              ) : quote.isError ? (
                <span className="text-destructive">{errorMessage(quote.error, 'This plan cannot be bought right now')}</span>
              ) : quote.data ? (
                <>
                  <p>
                    To pay now: <strong>{formatMoney(quote.data.payableMinor, quote.data.currency)}</strong>
                    {quote.data.proration?.appliedMinor ? <span className="text-muted-foreground"> · after {formatMoney(quote.data.proration.appliedMinor, quote.data.currency)} credit</span> : null}
                  </p>
                  {kind && KIND_TEXT[kind] && <p className="text-xs text-muted-foreground">{KIND_TEXT[kind]}</p>}
                </>
              ) : null}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {workspace?.planCode && (
            <Button variant={kind === 'downgrade' || isCurrent ? 'default' : 'outline'} disabled={!plan || busy} loading={schedule.isPending} onClick={() => schedule.mutate()}>
              At next renewal
            </Button>
          )}
          <Button variant={kind === 'downgrade' ? 'outline' : 'default'} disabled={!quote.data || quote.isError || busy} loading={payNow.isPending} onClick={() => payNow.mutate()}>
            Pay from wallet now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
