import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Building2, CircleDollarSign, LogOut, Pause, Play, Plus, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { MoneyInput } from '@/components/MoneyInput';
import { ApiError } from '@/api/client';
import { platformApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';

interface TenantRow {
  _id: string;
  name: string;
  slug: string;
  status: string;
  subscriptionStatus: string;
  subscriptionEndsAt: string | null;
  contactEmail: string;
  contactPhone: string;
  storeCount: number;
  userCount: number;
  saleCount: number;
  createdAt: string;
}

/**
 * Platform administration.
 *
 * Deliberately a separate surface from the tenant POS: it is reached by a
 * platform_admin account, which `resolveTenant` refuses outright, so these two
 * worlds cannot be mixed up.
 */
export function PlatformPage() {
  const { session, logout } = useAuth();
  const { data: overview } = useQuery({ queryKey: ['platform', 'overview'], queryFn: platformApi.overview });

  return (
    <div className="min-h-full bg-muted/30">
      <header className="flex h-14 items-center gap-3 border-b bg-card px-4 lg:px-6">
        <Building2 className="h-5 w-5 text-primary" />
        <div className="flex-1">
          <p className="text-sm font-semibold">Platform administration</p>
          <p className="text-xs text-muted-foreground">{session?.user.email}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void logout().then(() => window.location.assign('/login'))}>
          <LogOut />
          Sign out
        </Button>
      </header>

      <div className="space-y-5 p-4 lg:p-6">
        <PageHeader title="Overview" description="Every workspace, subscription and payment on this deployment." />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MiniStat icon={<Building2 className="h-4 w-4" />} label="Tenants" value={String(overview?.tenants ?? 0)} />
          <MiniStat label="Active" value={String(overview?.activeTenants ?? 0)} />
          <MiniStat label="Suspended" value={String(overview?.suspendedTenants ?? 0)} />
          <MiniStat
            icon={<CircleDollarSign className="h-4 w-4" />}
            label="Revenue collected"
            value={formatMoney((overview?.revenue as { totalMinor: number })?.totalMinor ?? 0, 'BDT')}
          />
        </div>

        <Tabs defaultValue="tenants">
          <TabsList>
            <TabsTrigger value="tenants">Tenants</TabsTrigger>
            <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
          </TabsList>

          <TabsContent value="tenants">
            <TenantsTab />
          </TabsContent>
          <TabsContent value="subscriptions">
            <SubscriptionsTab />
          </TabsContent>
          <TabsContent value="payments">
            <PaymentsTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function MiniStat({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </div>
        <p className="tabular mt-1 text-2xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}

function TenantsTab() {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);
  const [assigning, setAssigning] = React.useState<TenantRow | null>(null);
  const [suspending, setSuspending] = React.useState<TenantRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['platform', 'tenants', page, search],
    queryFn: () => platformApi.tenants({ page, limit: 20, search }),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'suspended' }) =>
      platformApi.setTenantStatus(id, { status, reason: 'Changed by platform admin' }),
    onSuccess: (_result, variables) => {
      toast.success(variables.status === 'suspended' ? 'Tenant suspended' : 'Tenant reactivated');
      setSuspending(null);
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change the status'),
  });

  const rows = (data?.items ?? []) as unknown as TenantRow[];

  const columns: Column<TenantRow>[] = [
    {
      key: 'tenant',
      header: 'Workspace',
      cell: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-muted-foreground">{row.contactEmail || row.slug}</p>
        </div>
      ),
    },
    {
      key: 'subscription',
      header: 'Subscription',
      cell: (row) => (
        <div>
          <Badge
            variant={
              row.subscriptionStatus === 'active'
                ? 'success'
                : row.subscriptionStatus === 'trial'
                  ? 'warning'
                  : 'destructive'
            }
          >
            {row.subscriptionStatus}
          </Badge>
          {row.subscriptionEndsAt && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              until {format(new Date(row.subscriptionEndsAt), 'd MMM yyyy')}
            </p>
          )}
        </div>
      ),
    },
    { key: 'stores', header: 'Stores', cell: (row) => <span className="tabular">{row.storeCount}</span> },
    { key: 'users', header: 'Users', cell: (row) => <span className="tabular">{row.userCount}</span> },
    { key: 'sales', header: 'Sales', cell: (row) => <span className="tabular">{row.saleCount}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (row) =>
        row.status === 'active' ? <Badge variant="success">Active</Badge> : <Badge variant="destructive">Suspended</Badge>,
    },
    {
      key: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <Button variant="outline" size="sm" onClick={() => setAssigning(row)}>
            <Plus />
            Subscription
          </Button>
          {row.status === 'active' ? (
            <Button variant="ghost" size="icon-sm" onClick={() => setSuspending(row)} aria-label="Suspend">
              <Pause />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setStatus.mutate({ id: row._id, status: 'active' })}
              aria-label="Reactivate"
            >
              <Play />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <SearchInput value={term} onChange={setTerm} placeholder="Search workspaces…" className="max-w-sm" />

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row._id}
          loading={isLoading}
          meta={data?.meta}
          onPageChange={setPage}
          emptyTitle="No tenants yet"
          emptyDescription="Workspaces appear here as businesses sign up."
        />
      </Card>

      <AssignSubscriptionDialog tenant={assigning} onClose={() => setAssigning(null)} />

      <ConfirmDialog
        open={Boolean(suspending)}
        onOpenChange={(open) => !open && setSuspending(null)}
        title={`Suspend "${suspending?.name}"?`}
        description="Every user in this workspace is blocked immediately. Their data is untouched and access can be restored at any time."
        confirmLabel="Suspend workspace"
        destructive
        loading={setStatus.isPending}
        onConfirm={() => {
          if (suspending) setStatus.mutate({ id: suspending._id, status: 'suspended' });
        }}
      />
    </div>
  );
}

/** Manual subscription activation — the offline/agent-collected payment path. */
function AssignSubscriptionDialog({ tenant, onClose }: { tenant: TenantRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [planId, setPlanId] = React.useState('');
  const [periods, setPeriods] = React.useState('1');
  const [startDate, setStartDate] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [recordPayment, setRecordPayment] = React.useState(true);
  const [amountMinor, setAmountMinor] = React.useState<number | null>(null);
  const [reference, setReference] = React.useState('');

  const { data: plans } = useQuery({ queryKey: ['platform', 'plans'], queryFn: platformApi.allPlans, enabled: Boolean(tenant) });

  React.useEffect(() => {
    if (!tenant) return;
    setPlanId('');
    setPeriods('1');
    setStartDate('');
    setNotes('');
    setRecordPayment(true);
    setAmountMinor(null);
    setReference('');
  }, [tenant]);

  // Default the recorded amount to the plan price × periods.
  React.useEffect(() => {
    const plan = plans?.find((p) => p._id === planId);
    if (plan) setAmountMinor(plan.priceMinor * Math.max(1, Number(periods) || 1));
  }, [planId, periods, plans]);

  const assign = useMutation({
    mutationFn: () =>
      platformApi.assignSubscription({
        tenantId: tenant!._id,
        planId,
        periods: Number(periods) || 1,
        ...(startDate ? { startDate: new Date(startDate).toISOString() } : {}),
        status: 'active',
        autoRenew: false,
        notes,
        ...(recordPayment && amountMinor !== null
          ? { recordPayment: { amountMinor, provider: 'manual', reference } }
          : {}),
      }),
    onSuccess: () => {
      toast.success('Subscription activated');
      onClose();
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not assign the subscription'),
  });

  return (
    <Dialog open={Boolean(tenant)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign a subscription</DialogTitle>
          <DialogDescription>
            Manually activate a plan for <strong>{tenant?.name}</strong>. This supersedes any running subscription.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Plan</Label>
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a plan" />
              </SelectTrigger>
              <SelectContent>
                {(plans ?? []).map((plan) => (
                  <SelectItem key={plan._id} value={plan._id}>
                    {plan.name} — {formatMoney(plan.priceMinor, plan.currency)}/{plan.interval === 'yearly' ? 'yr' : 'mo'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Billing periods</Label>
              <Input
                type="text"
                inputMode="numeric"
                value={periods}
                onChange={(e) => /^\d*$/.test(e.target.value) && setPeriods(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Start date (optional)</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label>Record an offline payment</Label>
              <p className="text-xs text-muted-foreground">Logs what the customer actually paid</p>
            </div>
            <Switch checked={recordPayment} onCheckedChange={setRecordPayment} />
          </div>

          {recordPayment && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Amount received</Label>
                <MoneyInput value={amountMinor} onChange={setAmountMinor} ariaLabel="Amount received" />
              </div>
              <div className="space-y-1.5">
                <Label>Reference</Label>
                <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="bKash TRX ID, bank slip…" />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!planId} loading={assign.isPending} onClick={() => assign.mutate()}>
            Activate subscription
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SubscriptionsTab() {
  const [page, setPage] = React.useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['platform', 'subscriptions', page],
    queryFn: () => platformApi.subscriptions({ page, limit: 20 }),
  });

  const rows = (data?.items ?? []) as unknown as {
    _id: string;
    tenantId: { name: string; slug: string } | null;
    planSnapshot: { name: string; priceMinor: number; currency: string; interval: string };
    status: string;
    currentPeriodEnd: string;
    autoRenew: boolean;
    cancelAtPeriodEnd: boolean;
    isManual: boolean;
  }[];

  const columns: Column<(typeof rows)[number]>[] = [
    { key: 'tenant', header: 'Workspace', cell: (row) => <span className="font-medium">{row.tenantId?.name ?? '—'}</span> },
    {
      key: 'plan',
      header: 'Plan',
      cell: (row) => (
        <div>
          <p className="text-sm">{row.planSnapshot.name}</p>
          <p className="tabular text-xs text-muted-foreground">
            {formatMoney(row.planSnapshot.priceMinor, row.planSnapshot.currency)}/{row.planSnapshot.interval === 'yearly' ? 'yr' : 'mo'}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          <Badge variant={row.status === 'active' ? 'success' : row.status === 'trial' ? 'warning' : 'destructive'}>
            {row.status}
          </Badge>
          {row.cancelAtPeriodEnd && <Badge variant="warning">ending</Badge>}
          {row.isManual && <Badge variant="secondary">manual</Badge>}
        </div>
      ),
    },
    {
      key: 'ends',
      header: 'Period end',
      cell: (row) => <span className="text-sm">{format(new Date(row.currentPeriodEnd), 'd MMM yyyy')}</span>,
    },
    {
      key: 'renew',
      header: 'Auto-renew',
      cell: (row) => (row.autoRenew ? <Badge variant="success">On</Badge> : <Badge variant="secondary">Off</Badge>),
    },
  ];

  return (
    <Card>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row._id}
        loading={isLoading}
        meta={data?.meta}
        onPageChange={setPage}
        emptyTitle="No subscriptions yet"
      />
    </Card>
  );
}

function PaymentsTab() {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['platform', 'payments', page],
    queryFn: () => platformApi.payments({ page, limit: 20 }),
  });

  const markPaid = useMutation({
    mutationFn: (id: string) => platformApi.markPaid(id, { note: 'Confirmed by platform admin' }),
    onSuccess: () => {
      toast.success('Payment marked as received');
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not update the payment'),
  });

  const rows = (data?.items ?? []) as unknown as {
    _id: string;
    tenantId: { name: string } | null;
    amountMinor: number;
    currency: string;
    provider: string;
    status: string;
    providerReference: string | null;
    paidAt: string | null;
    createdAt: string;
  }[];

  const columns: Column<(typeof rows)[number]>[] = [
    { key: 'tenant', header: 'Workspace', cell: (row) => <span className="font-medium">{row.tenantId?.name ?? '—'}</span> },
    {
      key: 'amount',
      header: 'Amount',
      cell: (row) => <span className="tabular font-semibold">{formatMoney(row.amountMinor, row.currency)}</span>,
    },
    { key: 'provider', header: 'Provider', cell: (row) => <Badge variant="secondary">{row.provider}</Badge> },
    { key: 'ref', header: 'Reference', cell: (row) => <span className="font-mono text-xs">{row.providerReference || '—'}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <Badge variant={row.status === 'paid' ? 'success' : row.status === 'pending' ? 'warning' : 'destructive'}>
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'date',
      header: 'Date',
      cell: (row) => (
        <span className="text-sm text-muted-foreground">
          {format(new Date(row.paidAt ?? row.createdAt), 'd MMM yyyy')}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) =>
        row.status === 'pending' ? (
          <Button variant="outline" size="sm" loading={markPaid.isPending} onClick={() => markPaid.mutate(row._id)}>
            Mark received
          </Button>
        ) : null,
    },
  ];

  return (
    <Card>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row._id}
        loading={isLoading}
        meta={data?.meta}
        onPageChange={setPage}
        emptyTitle="No payments recorded"
      />
    </Card>
  );
}

export { Users };
