import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { ArrowRight, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { ApiError } from '@/api/client';
import { onboardingApi, workspaceApi, type AccountDashboard, type PurchaseQuote } from '@/api/endpoints';
import { useAuth } from '@/hooks/useAuth';
import { formatMoney } from '@/lib/money';
import { homePathForVertical } from '@/lib/verticalRoutes';

type Workspace = AccountDashboard['workspaces'][number];

const STATUS_BADGE: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  active: 'success',
  trialing: 'warning',
  past_due: 'warning',
  cancelled: 'warning',
  expired: 'destructive',
  suspended: 'destructive',
};
const DASHBOARD_KEY = ['account', 'dashboard'] as const;
const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);
const newKey = () => `chk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * The account's home: every POS workspace, its plan and renewal, a quick way
 * into each, and "Add New POS". Opening a workspace switches the session - the
 * server checks ownership then and on every request after.
 */
export function AccountDashboardPage() {
  const { data, isLoading, isError } = useQuery({ queryKey: DASHBOARD_KEY, queryFn: onboardingApi.dashboard });
  const [adding, setAdding] = React.useState(false);
  const [choosingFor, setChoosingFor] = React.useState<{ id: string; name: string } | null>(null);

  if (isLoading) return <LoadingState label="Loading your POS workspaces…" />;
  if (isError || !data) return <div className="p-6"><EmptyState title="Could not load your workspaces" /></div>;

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="My POS"
        description={data.wallet ? `Wallet ${formatMoney(data.wallet.balanceMinor, data.wallet.currency)} · shared by all workspaces` : 'All your POS workspaces'}
        actions={
          <Button onClick={() => setAdding(true)} disabled={!data.addPos.canAdd}>
            <Plus />
            Add New POS
          </Button>
        }
      />
      {!data.addPos.canAdd && <p className="text-xs text-muted-foreground">This account has reached its limit of {data.addPos.maxWorkspaces} workspaces.</p>}

      <div className="grid gap-3 md:grid-cols-2">
        {data.workspaces.map((workspace) => (
          <WorkspaceCard key={workspace.id} workspace={workspace} onChoosePlan={() => setChoosingFor({ id: workspace.id, name: workspace.name })} />
        ))}
      </div>

      <AddPosDialog
        open={adding}
        onOpenChange={setAdding}
        options={data.addPos.options}
        onCreated={(created) => {
          setAdding(false);
          setChoosingFor(created);
        }}
      />
      <ChoosePlanDialog workspace={choosingFor} onClose={() => setChoosingFor(null)} />
    </div>
  );
}

function WorkspaceCard({ workspace, onChoosePlan }: { workspace: Workspace; onChoosePlan: () => void }) {
  const navigate = useNavigate();
  const { session, switchWorkspace } = useAuth();
  const open = useMutation({
    mutationFn: async () => {
      if (session?.tenant?.id !== workspace.id) await switchWorkspace(workspace.id);
    },
    onSuccess: () => navigate(workspace.needsPlan ? '/subscription' : homePathForVertical(workspace.posType as never)),
    onError: (error) => toast.error(errorMessage(error, 'Could not open this workspace')),
  });
  const status = workspace.subscription?.status ?? 'none';

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{workspace.name}</p>
            <p className="text-xs text-muted-foreground">{workspace.posTypeLabel} POS</p>
          </div>
          <Badge variant={STATUS_BADGE[status] ?? 'secondary'}>{workspace.subscription ? status.replace('_', ' ') : 'No plan'}</Badge>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Plan</dt>
          <dd>{workspace.subscription ? `${workspace.subscription.planName ?? workspace.subscription.planCode} · ${workspace.subscription.billingCycle}` : '—'}</dd>
          <dt className="text-muted-foreground">Renews</dt>
          <dd>{workspace.renewalDate ? format(new Date(workspace.renewalDate), 'd MMM yyyy') : '—'}</dd>
          <dt className="text-muted-foreground">Renewal amount</dt>
          <dd>{workspace.renewalAmountMinor !== null ? formatMoney(workspace.renewalAmountMinor, workspace.currency) : '—'}</dd>
        </dl>
        <div className="flex flex-wrap justify-end gap-2">
          {workspace.needsPlan && (
            <Button size="sm" variant="outline" onClick={onChoosePlan} disabled={!workspace.canOpen}>
              Choose plan
            </Button>
          )}
          <Button size="sm" loading={open.isPending} disabled={!workspace.canOpen} onClick={() => open.mutate()}>
            Open
            <ArrowRight />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Add New POS: the type (from the platform catalog), then the business details. The server creates it under this account. */
function AddPosDialog({
  open,
  onOpenChange,
  options,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: AccountDashboard['addPos']['options'];
  onCreated: (workspace: { id: string; name: string }) => void;
}) {
  const queryClient = useQueryClient();
  const available = options.filter((option) => option.available);
  const [vertical, setVertical] = React.useState('');
  const [businessName, setBusinessName] = React.useState('');
  const [contactPhone, setContactPhone] = React.useState('');
  const [contactEmail, setContactEmail] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setVertical(available[0]?.vertical ?? '');
      setBusinessName('');
      setContactPhone('');
      setContactEmail('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = useMutation({
    mutationFn: () => workspaceApi.create({ businessName: businessName.trim(), vertical, contactPhone: contactPhone.trim(), contactEmail: contactEmail.trim() }),
    onSuccess: (result) => {
      toast.success(`${result.workspace.name} is ready`, { description: result.trial.started ? `Your ${result.trial.days}-day free trial has started.` : 'Now choose its plan.' });
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
      onCreated({ id: String(result.workspace.id), name: result.workspace.name });
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not create the workspace')),
  });

  const valid = Boolean(vertical) && businessName.trim().length >= 2;

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add New POS</DialogTitle>
          <DialogDescription>A separate business with its own products, staff, sales and subscription, paid from your account wallet.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What type of POS?</legend>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
              {available.map((option) => (
                <label key={option.vertical} className={`cursor-pointer rounded-md border p-3 text-sm ${vertical === option.vertical ? 'border-primary ring-1 ring-primary' : ''}`}>
                  <input type="radio" name="add-pos-type" className="sr-only" value={option.vertical} checked={vertical === option.vertical} onChange={() => setVertical(option.vertical)} />
                  <span className="font-medium">{option.label}</span>
                  {option.description && <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="space-y-1.5">
            <Label htmlFor="add-pos-name">Business name</Label>
            <Input id="add-pos-name" value={businessName} maxLength={160} onChange={(event) => setBusinessName(event.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="add-pos-phone">Business phone (optional)</Label>
              <Input id="add-pos-phone" inputMode="tel" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-pos-email">Business email (optional)</Label>
              <Input id="add-pos-email" type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>
            Create and choose a plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Choosing a plan and cycle for one workspace. The price shown is the server's
 * quote, and the confirmation sends that quote back so the server can refuse
 * if the price changed - it always charges its own price.
 */
function ChoosePlanDialog({ workspace, onClose }: { workspace: { id: string; name: string } | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [plan, setPlan] = React.useState('');
  const [billingCycle, setBillingCycle] = React.useState<'monthly' | 'annual'>('monthly');
  const [operationKey, setOperationKey] = React.useState(newKey);

  const options = useQuery({ queryKey: ['workspace-plans', workspace?.id], queryFn: () => onboardingApi.plans(workspace!.id), enabled: Boolean(workspace) });
  React.useEffect(() => {
    if (workspace) {
      setPlan('');
      setBillingCycle('monthly');
      setOperationKey(newKey());
    }
  }, [workspace]);
  React.useEffect(() => {
    if (!plan && options.data?.catalog.plans[0]) setPlan(options.data.catalog.plans[0].code);
  }, [options.data, plan]);

  const quote = useQuery<PurchaseQuote>({
    queryKey: ['workspace-quote', workspace?.id, plan, billingCycle],
    queryFn: () => onboardingApi.quote(workspace!.id, { plan, billingCycle }),
    enabled: Boolean(workspace && plan),
    retry: false,
  });

  const pay = useMutation({
    mutationFn: () => onboardingApi.checkoutFromWallet(workspace!.id, { plan, billingCycle, idempotencyKey: operationKey, expectedPayableMinor: quote.data!.payableMinor }),
    onSuccess: () => {
      toast.success(`${workspace?.name} is on ${quote.data?.plan.name}`);
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && (error.details as { reason?: string } | undefined)?.reason === 'PRICE_CHANGED') {
        toast.warning('The price changed. Please review the new price.');
        setOperationKey(newKey());
        void quote.refetch();
        return;
      }
      toast.error(errorMessage(error, 'Could not complete the checkout'));
    },
  });

  return (
    <Dialog open={Boolean(workspace)} onOpenChange={(next) => !next && !pay.isPending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a plan for {workspace?.name}</DialogTitle>
          <DialogDescription>Prices are for this workspace's POS type and come from the server.</DialogDescription>
        </DialogHeader>
        {options.isLoading ? (
          <LoadingState label="Loading plans…" />
        ) : options.isError || !options.data ? (
          <EmptyState title="Plans are not available right now" />
        ) : (
          <div className="space-y-4">
            <div className="flex gap-2" role="radiogroup" aria-label="Billing cycle">
              {(['monthly', 'annual'] as const).map((cycle) => (
                <Button key={cycle} size="sm" variant={billingCycle === cycle ? 'default' : 'outline'} onClick={() => setBillingCycle(cycle)}>
                  {cycle === 'monthly' ? 'Monthly' : 'Annual'}
                </Button>
              ))}
            </div>
            <div className="grid gap-2" role="radiogroup" aria-label="Plan">
              {options.data.catalog.plans.map((option) => (
                <label key={option.code} className={`cursor-pointer rounded-md border p-3 text-sm ${plan === option.code ? 'border-primary ring-1 ring-primary' : ''}`}>
                  <input type="radio" name="plan" className="sr-only" value={option.code} checked={plan === option.code} onChange={() => setPlan(option.code)} />
                  <span className="font-medium">{option.displayName}</span>
                  {option.description && <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>}
                </label>
              ))}
            </div>
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              {quote.isLoading ? (
                'Pricing…'
              ) : quote.isError ? (
                <span className="text-destructive">{errorMessage(quote.error, 'This plan cannot be bought right now')}</span>
              ) : quote.data ? (
                <>
                  To pay now: <strong>{formatMoney(quote.data.payableMinor, quote.data.currency)}</strong>
                  <span className="block text-xs text-muted-foreground">Paid from your account wallet. Other payment methods are on the workspace's Subscription page.</span>
                </>
              ) : null}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pay.isPending}>
            Later
          </Button>
          <Button disabled={!quote.data || quote.isError} loading={pay.isPending} onClick={() => pay.mutate()}>
            Pay from wallet
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
