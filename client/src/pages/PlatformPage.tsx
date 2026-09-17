import { AccountsTab } from '@/features/platform/AccountsTab';
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Building2, CircleDollarSign, LogOut, Pause, Play, Plus, Users, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { PaymentInstructionsCard } from '@/features/platform/PaymentInstructionsCard';
import { PaymentOperationsTab } from '@/features/platform/PaymentOperationsTab';
import { PosProductsTab } from '@/features/platform/PosProductsTab';
import { PlansTab } from '@/features/platform/PlansTab';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { MoneyInput } from '@/components/MoneyInput';
import { EmptyState, LoadingState } from '@/components/states';
import { cn } from '@/lib/utils';
import { WalletAdjustDialog } from '@/features/platform/WalletAdjustDialog';
import { ApiError } from '@/api/client';
import { platformApi } from '@/api/endpoints';
import { formatMoney, formatPlanPrice } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import type { SubscriptionPlan } from '@/types/domain';

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
  /** The workspace's POS type; absent on rows that predate verticals (Clothing). */
  vertical?: string;
  createdAt: string;
}

/** Plans an admin may put a workspace of this POS type on: its own plans and shared ones. */
const plansForPosType = (plans: SubscriptionPlan[] | undefined, posType: string) =>
  (plans ?? []).filter((plan) => !plan.posProductCode || plan.posProductCode === posType);

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

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MiniStat icon={<Building2 className="h-4 w-4" />} label="Tenants" value={String(overview?.tenants ?? 0)} />
          <MiniStat label="Active" value={String(overview?.activeTenants ?? 0)} />
          <MiniStat label="Suspended" value={String(overview?.suspendedTenants ?? 0)} />
          <MiniStat
            icon={<CircleDollarSign className="h-4 w-4" />}
            label="Revenue collected"
            value={formatMoney((overview?.revenue as { totalMinor: number })?.totalMinor ?? 0, 'BDT')}
          />
        </div>

        {/* Five areas of responsibility rather than seven overlapping tabs.
            Billing gathers everything about money in one place - subscriptions,
            the requests awaiting a decision, and the payments already taken -
            which is how an operator actually works through a day. */}
        <Tabs defaultValue="workspaces">
          <TabsList>
            <TabsTrigger value="workspaces">Workspaces</TabsTrigger>
            <TabsTrigger value="accounts">Accounts</TabsTrigger>
            <TabsTrigger value="billing">Billing</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
            <TabsTrigger value="pos-types">POS types</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="audit">Audit log</TabsTrigger>
          </TabsList>

          <TabsContent value="workspaces">
            <TenantsTab />
          </TabsContent>

          <TabsContent value="accounts">
            <AccountsTab />
          </TabsContent>

          <TabsContent value="billing">
            <Tabs defaultValue="requests">
              <TabsList className="mb-3">
                <TabsTrigger value="requests">Pending requests</TabsTrigger>
                <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
                <TabsTrigger value="payments">Payments</TabsTrigger>
                <TabsTrigger value="plans">Plans</TabsTrigger>
              </TabsList>
              <TabsContent value="requests">
                <FinancialRequestsTab />
              </TabsContent>
              <TabsContent value="subscriptions">
                <SubscriptionsTab />
              </TabsContent>
              <TabsContent value="payments">
                <PaymentOperationsTab />
              </TabsContent>
              <TabsContent value="plans">
                <PlansTab />
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="analytics">
            <AnalyticsTab />
          </TabsContent>

          <TabsContent value="pos-types">
            <PosProductsTab />
          </TabsContent>

          <TabsContent value="settings">
            <Tabs defaultValue="payments">
              <TabsList className="mb-3">
                <TabsTrigger value="payments">Payment accounts</TabsTrigger>
                <TabsTrigger value="integrations">SMS &amp; email</TabsTrigger>
              </TabsList>
              <TabsContent value="payments">
                <PaymentInstructionsCard />
              </TabsContent>
              <TabsContent value="integrations">
                <IntegrationsTab />
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="audit">
            <AuditLogTab />
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
  const navigate = useNavigate();
  const [creating, setCreating] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);
  const [assigning, setAssigning] = React.useState<TenantRow | null>(null);
  const [funding, setFunding] = React.useState<TenantRow | null>(null);
  const [suspending, setSuspending] = React.useState<TenantRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['platform', 'tenants', page, search],
    queryFn: () => platformApi.tenants({ page, limit: 20, search }),
  });

  // Balance for the tenant being funded, fetched on demand rather than for
  // every row - the table itself does not need it.
  const { data: fundingWallet } = useQuery({
    queryKey: ['platform', 'wallet', funding?._id],
    queryFn: () => platformApi.tenantWallet(funding!._id),
    enabled: Boolean(funding),
  });
  const walletBalances: Record<string, number> = funding
    ? { [funding._id]: fundingWallet?.wallet.balanceMinor ?? 0 }
    : {};

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
      key: 'tenant', mobile: 'title',
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
      key: 'status', mobile: 'hide',
      header: 'Status',
      cell: (row) =>
        row.status === 'active' ? <Badge variant="success">Active</Badge> : <Badge variant="destructive">Suspended</Badge>,
    },
    {
      key: 'actions', mobile: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <Button size="sm" onClick={() => navigate(`/platform/workspaces/${row._id}`)}>
            Manage
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAssigning(row)}>
            <Plus />
            Subscription
          </Button>
          <Button variant="outline" size="sm" onClick={() => setFunding(row)}>
            <Wallet />
            Wallet
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
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={term} onChange={setTerm} placeholder="Search workspaces…" className="max-w-sm" />
        <Button className="ml-auto" onClick={() => setCreating(true)}>
          <Plus />
          Create workspace
        </Button>
      </div>

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

      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />

      <WalletAdjustDialog
        tenantId={funding?._id ?? null}
        tenantName={funding?.name}
        currentBalanceMinor={funding ? walletBalances[funding._id] : 0}
        onClose={() => setFunding(null)}
      />
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

/**
 * Creates a whole workspace for a customer - the entry point for the one-time
 * setup service. Everything downstream (branches, products, staff) is then done
 * from the workspace page.
 */
function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = React.useState({
    businessName: '',
    ownerName: '',
    ownerEmail: '',
    ownerPhone: '',
    password: '',
    planId: 'trial',
    storeName: '',
  });

  const { data: allPlans } = useQuery({ queryKey: ['platform', 'plans'], queryFn: platformApi.allPlans, enabled: open });
  // Workspaces created here are Clothing workspaces.
  const plans = React.useMemo(() => plansForPosType(allPlans, 'clothing'), [allPlans]);

  React.useEffect(() => {
    if (open) {
      setForm({ businessName: '', ownerName: '', ownerEmail: '', ownerPhone: '', password: '', planId: 'trial', storeName: '' });
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      platformApi.createWorkspace({
        businessName: form.businessName.trim(),
        owner: {
          name: form.ownerName.trim(),
          email: form.ownerEmail.trim(),
          phone: form.ownerPhone.trim(),
          password: form.password,
        },
        ...(form.planId !== 'trial' ? { planId: form.planId, periods: 1 } : {}),
        ...(form.storeName.trim() ? { storeName: form.storeName.trim() } : {}),
      }),
    onSuccess: (result) => {
      toast.success('Workspace created', { description: 'Continue the setup inside the workspace.' });
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
      navigate(`/platform/workspaces/${result.tenantId}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not create the workspace'),
  });

  const valid =
    form.businessName.trim().length >= 2 &&
    form.ownerName.trim().length >= 2 &&
    form.ownerEmail.trim().length >= 5 &&
    form.password.length >= 8;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a workspace</DialogTitle>
          <DialogDescription>
            Provisions the tenant, owner account, default roles and first store — the same objects a self-service
            signup creates.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Business name</Label>
            <Input autoFocus value={form.businessName} onChange={(e) => setForm((f) => ({ ...f, businessName: e.target.value }))} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Owner name</Label>
              <Input value={form.ownerName} onChange={(e) => setForm((f) => ({ ...f, ownerName: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Owner phone</Label>
              <Input value={form.ownerPhone} onChange={(e) => setForm((f) => ({ ...f, ownerPhone: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Owner email</Label>
              <Input type="email" value={form.ownerEmail} onChange={(e) => setForm((f) => ({ ...f, ownerEmail: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Temporary password</Label>
              <Input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Subscription</Label>
              <Select value={form.planId} onValueChange={(v) => setForm((f) => ({ ...f, planId: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="trial">Start on a trial</SelectItem>
                  {(plans ?? []).map((plan) => (
                    <SelectItem key={plan._id} value={plan._id}>
                      {plan.name} — {formatPlanPrice(plan.priceMinor, plan.currency)}/{plan.interval === 'yearly' ? 'year' : 'month'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Store name (optional)</Label>
              <Input value={form.storeName} onChange={(e) => setForm((f) => ({ ...f, storeName: e.target.value }))} placeholder="Defaults to the business name" />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>
            Create workspace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

  const { data: allPlans } = useQuery({ queryKey: ['platform', 'plans'], queryFn: platformApi.allPlans, enabled: Boolean(tenant) });
  // Only plans sold to this workspace's POS type; the server refuses the rest anyway.
  const plans = React.useMemo(() => plansForPosType(allPlans, tenant?.vertical ?? 'clothing'), [allPlans, tenant?.vertical]);

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
                    {plan.name} — {formatPlanPrice(plan.priceMinor, plan.currency)}/{plan.interval === 'yearly' ? 'year' : 'month'}
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
    { key: 'tenant', mobile: 'title', header: 'Workspace', cell: (row) => <span className="font-medium">{row.tenantId?.name ?? '—'}</span> },
    {
      key: 'plan',
      header: 'Plan',
      cell: (row) => (
        <div>
          <p className="text-sm">{row.planSnapshot.name}</p>
          <p className="tabular text-xs text-muted-foreground">
            {formatPlanPrice(row.planSnapshot.priceMinor, row.planSnapshot.currency)}/{row.planSnapshot.interval === 'yearly' ? 'year' : 'month'}
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
      key: 'renew', mobile: 'hide',
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

/**
 * The approval queue. A request only becomes an active subscription when a
 * human here confirms the transaction actually arrived.
 */
function UpgradeRequestsTab() {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [status, setStatus] = React.useState('pending');
  const [reviewing, setReviewing] = React.useState<{ id: string; action: 'approve' | 'reject'; plan: string } | null>(null);
  const [note, setNote] = React.useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['platform', 'upgrades', page, status],
    queryFn: () => platformApi.upgradeRequests({ page, limit: 20, ...(status !== 'all' ? { status } : {}) }),
  });

  const review = useMutation({
    mutationFn: () =>
      reviewing!.action === 'approve'
        ? platformApi.approveUpgrade(reviewing!.id, { reviewNote: note })
        : platformApi.rejectUpgrade(reviewing!.id, { reviewNote: note }),
    onSuccess: () => {
      toast.success(reviewing?.action === 'approve' ? 'Upgrade approved and activated' : 'Request rejected');
      setReviewing(null);
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not complete the review'),
  });

  const rows = (data?.items ?? []) as unknown as {
    _id: string;
    tenantId: { name: string; contactPhone?: string } | null;
    planSnapshot: { name: string; priceMinor: number; currency: string };
    currentPlanCodeSnapshot: string | null;
    paymentMethod: string;
    amountMinor: number;
    senderNumber: string;
    transactionId: string;
    status: string;
    createdAt: string;
    requestedByNameSnapshot: string;
  }[];

  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: 'tenant', mobile: 'title',
      header: 'Workspace',
      cell: (row) => (
        <div>
          <p className="font-medium">{row.tenantId?.name ?? '—'}</p>
          <p className="text-xs text-muted-foreground">{row.requestedByNameSnapshot}</p>
        </div>
      ),
    },
    {
      key: 'plan',
      header: 'Requested plan',
      cell: (row) => (
        <div>
          <p className="text-sm font-medium">{row.planSnapshot.name}</p>
          <p className="text-xs text-muted-foreground">from {row.currentPlanCodeSnapshot ?? 'no plan'}</p>
        </div>
      ),
    },
    {
      key: 'payment',
      header: 'Payment claimed',
      cell: (row) => (
        <div>
          <p className="tabular text-sm font-semibold">{formatMoney(row.amountMinor, row.planSnapshot.currency)}</p>
          <div className="text-xs text-muted-foreground">
            <Badge variant="secondary" className="mr-1">{row.paymentMethod}</Badge>
            {row.senderNumber}
          </div>
        </div>
      ),
    },
    {
      key: 'txn',
      header: 'Transaction ID',
      cell: (row) => <span className="font-mono text-xs">{row.transactionId}</span>,
    },
    {
      key: 'date', mobile: 'hide',
      header: 'Submitted',
      cell: (row) => <span className="text-sm text-muted-foreground">{format(new Date(row.createdAt), 'd MMM, hh:mm a')}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <Badge
          variant={row.status === 'approved' ? 'success' : row.status === 'pending' ? 'warning' : 'destructive'}
        >
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'actions', mobile: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) =>
        row.status === 'pending' ? (
          <div className="flex justify-end gap-1">
            <Button size="sm" onClick={() => setReviewing({ id: row._id, action: 'approve', plan: row.planSnapshot.name })}>
              Approve
            </Button>
            <Button variant="outline" size="sm" onClick={() => setReviewing({ id: row._id, action: 'reject', plan: row.planSnapshot.name })}>
              Reject
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {['pending', 'approved', 'rejected', 'all'].map((value) => (
          <Button
            key={value}
            variant={status === value ? 'default' : 'outline'}
            size="sm"
            className="capitalize"
            onClick={() => { setStatus(value); setPage(1); }}
          >
            {value}
          </Button>
        ))}
      </div>

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row._id}
          loading={isLoading}
          meta={data?.meta}
          onPageChange={setPage}
          emptyTitle="No upgrade requests"
          emptyDescription="Customer upgrade payments awaiting verification appear here."
        />
      </Card>

      <Dialog open={Boolean(reviewing)} onOpenChange={(open) => !open && setReviewing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {reviewing?.action === 'approve' ? `Approve upgrade to ${reviewing?.plan}?` : 'Reject this request?'}
            </DialogTitle>
            <DialogDescription>
              {reviewing?.action === 'approve'
                ? 'Confirm the transaction actually arrived. Approving activates the plan immediately and records the payment.'
                : 'The customer keeps their current plan. Add a note explaining why.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label>Review note</Label>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. bKash TXN verified against statement" />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(null)}>Cancel</Button>
            <Button
              variant={reviewing?.action === 'approve' ? 'default' : 'destructive'}
              loading={review.isPending}
              onClick={() => review.mutate()}
            >
              {reviewing?.action === 'approve' ? 'Approve & activate' : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Central approval queue.
 *
 * Top-up requests existed in the database with no admin UI, so a store owner
 * could submit one and nobody could see it. This is that missing surface.
 */
function FinancialRequestsTab() {
  const [tab, setTab] = React.useState<'topups' | 'upgrades'>('topups');

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button variant={tab === 'topups' ? 'default' : 'outline'} size="sm" onClick={() => setTab('topups')}>
          Wallet top-ups
        </Button>
        <Button variant={tab === 'upgrades' ? 'default' : 'outline'} size="sm" onClick={() => setTab('upgrades')}>
          Subscription upgrades
        </Button>
      </div>

      {tab === 'topups' ? <TopUpRequestsTab /> : <UpgradeRequestsTab />}
    </div>
  );
}

function TopUpRequestsTab() {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [status, setStatus] = React.useState('pending');
  const [reviewing, setReviewing] = React.useState<{ id: string; action: 'approve' | 'reject'; amount: number } | null>(null);
  const [note, setNote] = React.useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['platform', 'topups', page, status],
    queryFn: () => platformApi.topUps({ page, limit: 20, ...(status !== 'all' ? { status } : {}) }),
  });

  const review = useMutation({
    mutationFn: () =>
      reviewing!.action === 'approve'
        ? platformApi.approveTopUp(reviewing!.id, { reviewNote: note })
        : platformApi.rejectTopUp(reviewing!.id, { reviewNote: note }),
    onSuccess: () => {
      toast.success(reviewing?.action === 'approve' ? 'Top-up approved and wallet credited' : 'Request rejected');
      setReviewing(null);
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not complete the review'),
  });

  const rows = (data?.items ?? []) as unknown as {
    _id: string;
    tenantId: { name: string; contactPhone?: string } | null;
    requestedByNameSnapshot: string;
    amountMinor: number;
    currency: string;
    paymentMethod: string;
    senderNumber: string;
    transactionId: string;
    note: string;
    status: string;
    createdAt: string;
  }[];

  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: 'store', mobile: 'title',
      header: 'Store / owner',
      cell: (row) => (
        <div>
          <p className="font-medium">{row.tenantId?.name ?? '—'}</p>
          <p className="text-xs text-muted-foreground">{row.requestedByNameSnapshot}</p>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      cell: (row) => <span className="tabular font-semibold">{formatMoney(row.amountMinor, row.currency)}</span>,
    },
    {
      key: 'method',
      header: 'Method',
      cell: (row) => (
        <div>
          <Badge variant="secondary">{row.paymentMethod}</Badge>
          {row.senderNumber && <p className="mt-0.5 text-xs text-muted-foreground">{row.senderNumber}</p>}
        </div>
      ),
    },
    { key: 'txn', header: 'Transaction ID', cell: (row) => <span className="font-mono text-xs">{row.transactionId}</span> },
    { key: 'proof', mobile: 'hide', header: 'Note / proof', cell: (row) => <span className="text-xs text-muted-foreground">{row.note || '—'}</span> },
    {
      key: 'date', mobile: 'hide',
      header: 'Submitted',
      cell: (row) => <span className="text-sm text-muted-foreground">{format(new Date(row.createdAt), 'd MMM, hh:mm a')}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <Badge variant={row.status === 'approved' ? 'success' : row.status === 'pending' ? 'warning' : 'destructive'}>
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'actions', mobile: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) =>
        row.status === 'pending' ? (
          <div className="flex justify-end gap-1">
            <Button size="sm" onClick={() => setReviewing({ id: row._id, action: 'approve', amount: row.amountMinor })}>
              Approve
            </Button>
            <Button variant="outline" size="sm" onClick={() => setReviewing({ id: row._id, action: 'reject', amount: row.amountMinor })}>
              Reject
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {['pending', 'approved', 'rejected', 'all'].map((value) => (
          <Button key={value} variant={status === value ? 'default' : 'outline'} size="sm" className="capitalize" onClick={() => { setStatus(value); setPage(1); }}>
            {value}
          </Button>
        ))}
      </div>

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row._id}
          loading={isLoading}
          meta={data?.meta}
          onPageChange={setPage}
          emptyTitle="No wallet top-up requests"
          emptyDescription="Requests submitted by store owners appear here for verification."
        />
      </Card>

      <Dialog open={Boolean(reviewing)} onOpenChange={(open) => !open && setReviewing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {reviewing?.action === 'approve'
                ? `Credit ${formatMoney(reviewing?.amount ?? 0)} to this wallet?`
                : 'Reject this top-up?'}
            </DialogTitle>
            <DialogDescription>
              {reviewing?.action === 'approve'
                ? 'Confirm the money actually arrived. Approving credits the wallet immediately and writes a ledger entry.'
                : 'The wallet is not credited. Add a note explaining why.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label>Review note</Label>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. bKash statement checked" />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(null)}>Cancel</Button>
            <Button
              variant={reviewing?.action === 'approve' ? 'default' : 'destructive'}
              loading={review.isPending}
              onClick={() => review.mutate()}
            >
              {reviewing?.action === 'approve' ? 'Approve & credit' : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** SMS and SMTP configuration. Credentials are write-only from here. */
function IntegrationsTab() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['platform', 'integrations'], queryFn: platformApi.integrations });

  const [smsCost, setSmsCost] = React.useState<number | null>(null);
  const [emailCost, setEmailCost] = React.useState<number | null>(null);
  const [smtp, setSmtp] = React.useState({ host: '', port: '587', secure: false, username: '', password: '', fromName: '', fromEmail: '', enabled: false });
  const [sms, setSms] = React.useState({ provider: 'alpha', apiKey: '', baseUrl: '', senderId: '', enabled: false });

  React.useEffect(() => {
    if (!data) return;
    setSmsCost(data.sms.costMinor);
    setEmailCost(data.email.costMinor);
    setSms({
      provider: data.sms.config?.provider ?? 'alpha',
      // Never populated from the server - the key is write-only.
      apiKey: '',
      baseUrl: data.sms.config?.baseUrl ?? 'https://api.sms.net.bd',
      senderId: data.sms.config?.senderId ?? '',
      enabled: Boolean(data.sms.config?.enabled),
    });
    setSmtp({
      host: data.email.smtp.host ?? '',
      port: String(data.email.smtp.port ?? 587),
      secure: Boolean(data.email.smtp.secure),
      username: data.email.smtp.username ?? '',
      password: '',
      fromName: data.email.smtp.fromName ?? '',
      fromEmail: data.email.smtp.fromEmail ?? '',
      enabled: Boolean(data.email.smtp.enabled),
    });
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      platformApi.updateSettings({
        ...(smsCost !== null ? { smsCostMinor: smsCost } : {}),
        ...(emailCost !== null ? { emailCostMinor: emailCost } : {}),
        sms: {
          provider: sms.provider,
          // Blank means "keep the stored key", matching the SMTP password.
          ...(sms.apiKey ? { apiKey: sms.apiKey } : {}),
          baseUrl: sms.baseUrl.trim(),
          senderId: sms.senderId.trim(),
          enabled: sms.enabled,
        },
        smtp: {
          host: smtp.host.trim(),
          port: Number(smtp.port) || 587,
          secure: smtp.secure,
          username: smtp.username.trim(),
          // Blank means "keep the stored password".
          ...(smtp.password ? { password: smtp.password } : {}),
          fromName: smtp.fromName.trim(),
          fromEmail: smtp.fromEmail.trim(),
          enabled: smtp.enabled,
        },
      }),
    onSuccess: () => {
      toast.success('Integration settings saved');
      void queryClient.invalidateQueries({ queryKey: ['platform', 'integrations'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save'),
  });

  const testSms = useMutation({
    mutationFn: () => platformApi.testSms(),
    onSuccess: (result) =>
      result.ok
        ? toast.success('Gateway verified', {
            description:
              result.balanceMinor !== null && result.balanceMinor !== undefined
                ? `Account balance: ${formatMoney(result.balanceMinor, result.currency ?? 'BDT')}`
                : undefined,
          })
        : toast.error('Gateway check failed', { description: result.message }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Test failed'),
  });

  const test = useMutation({
    mutationFn: () => platformApi.testSmtp(),
    onSuccess: (result) =>
      result.ok
        ? toast.success('SMTP connection verified')
        : toast.error('SMTP verification failed', { description: result.error }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Test failed'),
  });

  if (isLoading || !data) return <LoadingState />;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">SMS gateway</CardTitle>
            <Badge variant={data.sms.config?.apiKeySet ? 'success' : 'secondary'}>
              {data.sms.config?.apiKeySet ? 'Key stored' : 'No key'}
            </Badge>
          </div>
          <CardDescription>
            Stored on the server and never shown again. Store owners only ever see whether SMS is available.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.sms.providers.map((provider: { name: string; displayName: string; configured: boolean }) => (
            <div key={provider.name} className="flex items-center justify-between rounded-md border p-3 text-sm">
              <span>{provider.displayName}</span>
              <Badge variant={provider.configured ? 'success' : 'secondary'}>
                {provider.configured ? 'Configured' : 'Not configured'}
              </Badge>
            </div>
          ))}

          <div className="space-y-1.5">
            <Label htmlFor="sms-key">API key</Label>
            <Input
              id="sms-key"
              type="password"
              autoComplete="off"
              value={sms.apiKey}
              onChange={(e) => setSms((f) => ({ ...f, apiKey: e.target.value }))}
              placeholder={data.sms.config?.apiKeySet ? 'Stored — leave blank to keep it' : 'Paste the gateway API key'}
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to keep the current key. Saving a new value replaces it.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sms-url">API base URL</Label>
              <Input
                id="sms-url"
                value={sms.baseUrl}
                onChange={(e) => setSms((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder="https://api.sms.net.bd"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sms-sender">Sender ID</Label>
              <Input
                id="sms-sender"
                value={sms.senderId}
                onChange={(e) => setSms((f) => ({ ...f, senderId: e.target.value }))}
                placeholder="Optional"
              />
            </div>
          </div>

          <label className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label>Enable sending</Label>
              <p className="text-xs text-muted-foreground">
                When off, the gateway is treated as unconfigured and nothing is sent.
              </p>
            </div>
            <Switch checked={sms.enabled} onCheckedChange={(v) => setSms((f) => ({ ...f, enabled: v }))} />
          </label>

          {data.sms.balance?.balanceMinor !== null && data.sms.balance?.balanceMinor !== undefined && (
            <div className="flex items-center justify-between rounded-md border bg-muted/40 p-3 text-sm">
              <span className="text-muted-foreground">Gateway account balance</span>
              <span className="tabular font-medium">
                {formatMoney(data.sms.balance.balanceMinor, data.sms.balance.currency ?? 'BDT')}
              </span>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Price charged to stores, per SMS</Label>
            <MoneyInput value={smsCost} onChange={setSmsCost} ariaLabel="SMS price" />
          </div>

          <Button variant="outline" className="w-full" loading={testSms.isPending} onClick={() => testSms.mutate()}>
            Test these credentials
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Email — SMTP</CardTitle>
          <CardDescription>Used for marketing email campaigns.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Host" value={smtp.host} onChange={(v) => setSmtp((s) => ({ ...s, host: v }))} placeholder="smtp.example.com" />
            <Field label="Port" value={smtp.port} onChange={(v) => /^\d*$/.test(v) && setSmtp((s) => ({ ...s, port: v }))} />
            <Field label="Username" value={smtp.username} onChange={(v) => setSmtp((s) => ({ ...s, username: v }))} />
            <div className="space-y-1.5">
              <Label>Password</Label>
              <Input
                type="password"
                value={smtp.password}
                onChange={(e) => setSmtp((s) => ({ ...s, password: e.target.value }))}
                placeholder={data.email.smtp.passwordSet ? 'Leave blank to keep current' : ''}
              />
            </div>
            <Field label="From name" value={smtp.fromName} onChange={(v) => setSmtp((s) => ({ ...s, fromName: v }))} />
            <Field label="From email" value={smtp.fromEmail} onChange={(v) => setSmtp((s) => ({ ...s, fromEmail: v }))} />
          </div>

          <label className="flex items-center justify-between rounded-md border p-3 text-sm">
            <span>Use TLS/SSL (port 465)</span>
            <Switch checked={smtp.secure} onCheckedChange={(v) => setSmtp((s) => ({ ...s, secure: v }))} />
          </label>
          <label className="flex items-center justify-between rounded-md border p-3 text-sm">
            <span>Enable email sending</span>
            <Switch checked={smtp.enabled} onCheckedChange={(v) => setSmtp((s) => ({ ...s, enabled: v }))} />
          </label>

          <div className="space-y-1.5">
            <Label>Price charged to stores, per email</Label>
            <MoneyInput value={emailCost} onChange={setEmailCost} ariaLabel="Email price" />
          </div>

          <div className="flex gap-2">
            <Button loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button>
            <Button variant="outline" loading={test.isPending} onClick={() => test.mutate()}>
              Test connection
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

/** Immutable trail of sensitive admin actions. */
function AuditLogTab() {
  const [page, setPage] = React.useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['platform', 'audit', page],
    queryFn: () => platformApi.auditLog({ page, limit: 25 }),
  });

  const rows = (data?.items ?? []) as unknown as {
    _id: string;
    actorNameSnapshot: string;
    actorRole: string;
    action: string;
    targetTenantId: { name: string } | null;
    targetLabel: string;
    newValue: unknown;
    createdAt: string;
  }[];

  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: 'when',
      header: 'When',
      cell: (row) => <span className="text-sm text-muted-foreground">{format(new Date(row.createdAt), 'd MMM yyyy, hh:mm a')}</span>,
    },
    {
      key: 'actor',
      header: 'Actor',
      cell: (row) => (
        <div>
          <p className="text-sm font-medium">{row.actorNameSnapshot}</p>
          <p className="text-xs text-muted-foreground">{row.actorRole}</p>
        </div>
      ),
    },
    { key: 'action', header: 'Action', cell: (row) => <Badge variant="secondary">{row.action}</Badge> },
    {
      key: 'target',
      header: 'Target',
      cell: (row) => (
        <div>
          <p className="text-sm">{row.targetTenantId?.name ?? '—'}</p>
          {row.targetLabel && <p className="text-xs text-muted-foreground">{row.targetLabel}</p>}
        </div>
      ),
    },
    {
      key: 'detail',
      header: 'Detail',
      cell: (row) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.newValue ? JSON.stringify(row.newValue).slice(0, 60) : '—'}
        </span>
      ),
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
        emptyTitle="No audit entries yet"
        emptyDescription="Sensitive platform actions are recorded here."
      />
    </Card>
  );
}

/**
 * Platform-wide analytics.
 *
 * Every figure comes from a MongoDB aggregation over the selected range - no
 * dataset is pulled into the browser to be summed.
 */
function AnalyticsTab() {
  const [preset, setPreset] = React.useState('last30');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [sortBy, setSortBy] = React.useState('revenue');

  const isCustom = preset === 'custom';
  const ready = !isCustom || (from && to);
  const params = isCustom
    ? { preset: 'custom', from: new Date(from).toISOString(), to: new Date(`${to}T23:59:59`).toISOString() }
    : { preset };

  const { data, isLoading } = useQuery({
    queryKey: ['platform', 'analytics', params],
    queryFn: () => platformApi.analytics(params),
    enabled: Boolean(ready),
  });

  const { data: leaderboard } = useQuery({
    queryKey: ['platform', 'leaderboard', params, sortBy],
    queryFn: () => platformApi.workspaceLeaderboard({ ...params, sortBy, limit: 15 }),
    enabled: Boolean(ready),
  });

  const currency = 'BDT';

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 p-4">
          {[
            ['today', 'Today'],
            ['last7', '7 days'],
            ['last30', '30 days'],
            ['thisMonth', 'This month'],
            ['lastMonth', 'Last month'],
            ['thisYear', 'This year'],
          ].map(([value, label]) => (
            <Button key={value} variant={preset === value ? 'default' : 'outline'} size="sm" onClick={() => setPreset(value)}>
              {label}
            </Button>
          ))}
          <Button variant={isCustom ? 'default' : 'outline'} size="sm" onClick={() => setPreset('custom')}>
            Custom
          </Button>
          {isCustom && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">From</Label>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">To</Label>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {!ready && <EmptyState title="Pick a start and end date" />}
      {isLoading && <LoadingState />}

      {data && (
        <>
          <Section title="Revenue">
            <Metric label="Subscriptions" value={formatMoney(data.revenue.subscriptionMinor, currency)} />
            <Metric label="Wallet top-ups" value={formatMoney(data.revenue.walletTopUpMinor, currency)} />
            <Metric label="SMS" value={formatMoney(data.revenue.smsMinor, currency)} />
            <Metric label="Email" value={formatMoney(data.revenue.emailMinor, currency)} />
            <Metric label="Setup services" value={formatMoney(data.revenue.setupServiceMinor, currency)} />
            <Metric label="Total revenue" value={formatMoney(data.revenue.totalMinor, currency)} tone="success" />
          </Section>

          <Section title="Users & workspaces">
            <Metric label="Total users" value={String(data.users.total)} />
            <Metric label="Active" value={String(data.users.active)} />
            <Metric label="Suspended" value={String(data.users.suspended)} tone={data.users.suspended > 0 ? 'warning' : undefined} />
            <Metric label="New users" value={String(data.users.new)} />
            <Metric label="Workspaces" value={String(data.workspaces.total)} />
            <Metric label="Active" value={String(data.workspaces.active)} />
            <Metric label="Suspended" value={String(data.workspaces.suspended)} />
            <Metric label="New workspaces" value={String(data.workspaces.new)} />
          </Section>

          <Section title="Subscriptions">
            <Metric label="Active" value={String(data.subscriptions.active)} />
            <Metric label="Trial" value={String(data.subscriptions.trial)} />
            <Metric label="Past due" value={String(data.subscriptions.pastDue)} />
            <Metric label="Cancelled" value={String(data.subscriptions.cancelled)} />
            <Metric label="Expired" value={String(data.subscriptions.expired)} />
            <Metric label="Monthly" value={String(data.subscriptions.monthly)} />
            <Metric label="Annual" value={String(data.subscriptions.annual)} />
            <Metric label="Upgrades" value={String(data.subscriptions.upgrades)} />
            <Metric label="Cycle changes" value={String(data.subscriptions.cycleChanges)} />
            <Metric label="Downgrade requests" value={String(data.subscriptions.downgradeRequests)} />
            <Metric label="Pending" value={String(data.subscriptions.pendingRequests)} tone={data.subscriptions.pendingRequests > 0 ? 'warning' : undefined} />
          </Section>

          {data.subscriptions.byPlan.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Plan distribution</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {data.subscriptions.byPlan.map((row: { code: string; interval: string; count: number }) => (
                    <li key={`${row.code}-${row.interval}`} className="flex items-center justify-between text-sm">
                      <span>
                        {row.code} <Badge variant="secondary">{row.interval}</Badge>
                      </span>
                      <span className="tabular font-medium">{row.count}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Section title="POS business (all stores)">
            <Metric label="Gross sales" value={formatMoney(data.business.grossSalesMinor, currency)} />
            <Metric label="Discounts" value={formatMoney(data.business.discountsMinor, currency)} />
            <Metric label="Returns" value={formatMoney(data.business.returnsMinor, currency)} />
            <Metric label="Net sales" value={formatMoney(data.business.netSalesMinor, currency)} />
            <Metric label="COGS" value={formatMoney(data.business.cogsMinor, currency)} />
            <Metric label="Profit" value={formatMoney(data.business.profitMinor, currency)} tone="success" />
            <Metric label="Orders" value={String(data.business.orders)} />
            <Metric label="Items sold" value={String(data.business.itemsSold)} />
          </Section>

          <Section title="Marketing">
            <Metric label="SMS sent" value={String(data.marketing.smsCount)} />
            <Metric label="Emails sent" value={String(data.marketing.emailCount)} />
            <Metric label="SMS revenue" value={formatMoney(data.marketing.smsRevenueMinor, currency)} />
            <Metric label="Email revenue" value={formatMoney(data.marketing.emailRevenueMinor, currency)} />
          </Section>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">Top workspaces</CardTitle>
                  <CardDescription>Profit uses the cost captured at the time of each sale.</CardDescription>
                </div>
                <Select value={sortBy} onValueChange={setSortBy}>
                  <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="revenue">Revenue</SelectItem>
                    <SelectItem value="profit">Profit</SelectItem>
                    <SelectItem value="orders">Orders</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="scrollbar-thin overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 text-left font-semibold">Workspace</th>
                      <th className="px-4 py-2 text-right font-semibold">Orders</th>
                      <th className="px-4 py-2 text-right font-semibold">Sales</th>
                      <th className="px-4 py-2 text-right font-semibold">Profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(leaderboard?.rows ?? []).map((row: import('@/api/endpoints').UntypedAdminPayload) => (
                      <tr key={String(row.tenantId)} className="border-b last:border-0">
                        <td className="px-4 py-2">
                          <p className="font-medium">{row.name ?? '—'}</p>
                          <Badge variant="secondary">{row.subscriptionStatus}</Badge>
                        </td>
                        <td className="tabular px-4 py-2 text-right">{row.orders}</td>
                        <td className="tabular px-4 py-2 text-right">{formatMoney(row.grossMinor, currency)}</td>
                        <td className="tabular px-4 py-2 text-right font-medium text-success">{formatMoney(row.profitMinor, currency)}</td>
                      </tr>
                    ))}
                    {(leaderboard?.rows ?? []).length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                          No sales in this period
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">{children}</CardContent>
    </Card>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'warning' }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          'tabular mt-0.5 text-lg font-semibold',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
        )}
      >
        {value}
      </p>
    </div>
  );
}

export { Users };
