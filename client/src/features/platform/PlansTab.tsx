import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Info, Pencil, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { MoneyInput } from '@/components/MoneyInput';
import { LoadingState } from '@/components/states';
import { ApiError } from '@/api/client';
import { platformApi, type AdminPlan, type PosProduct } from '@/api/endpoints';
import { formatPlanPrice } from '@/lib/money';
import { FEATURE_LABELS } from '@/lib/planCatalog';

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const per = (interval: string) => (interval === 'yearly' ? 'year' : 'month');
const MB = 1024 * 1024;

/** New plans start from the same defaults the server applies. */
const DEFAULT_FEATURES: Record<string, boolean> = {
  salesReports: true,
  advancedReports: false,
  customerManagement: true,
  inventoryLedger: true,
  multiStore: false,
  customRoles: false,
  exportData: false,
  prioritySupport: false,
  smsMarketing: false,
  emailMarketing: false,
  imageOptimization: false,
};

const DEFAULT_LIMITS: Record<string, number> = {
  maxStores: 1,
  maxStaff: 2,
  maxProducts: 200,
  maxMonthlySales: -1,
  maxCustomers: -1,
  maxStorageBytes: -1,
};

const LIMIT_FIELDS: { key: string; label: string; bytes?: boolean }[] = [
  { key: 'maxStores', label: 'Branches' },
  { key: 'maxStaff', label: 'Staff accounts' },
  { key: 'maxProducts', label: 'Products' },
  { key: 'maxMonthlySales', label: 'Sales per month' },
  { key: 'maxCustomers', label: 'Customer profiles' },
  { key: 'maxStorageBytes', label: 'Storage', bytes: true },
];

const STATUS_LABELS: Record<string, string> = {
  trial: 'Trial',
  active: 'Active',
  past_due: 'Payment overdue',
  cancelled: 'Cancelling',
  expired: 'Ended',
};

/**
 * Platform plan management: what each POS type can buy, at what price, with
 * which features and limits. The server enforces every rule (catalog POS types,
 * scope changes, validation); this screen only collects the edit and explains
 * what it will affect.
 */
export function PlansTab() {
  const queryClient = useQueryClient();
  const [scope, setScope] = React.useState('all');
  const [editing, setEditing] = React.useState<AdminPlan | 'new' | null>(null);
  const [usageOf, setUsageOf] = React.useState<AdminPlan | null>(null);
  const [withdrawing, setWithdrawing] = React.useState<AdminPlan | null>(null);

  const { data: posProducts } = useQuery({ queryKey: ['platform', 'pos-products'], queryFn: platformApi.posProducts });
  const { data: plans, isLoading, error, refetch } = useQuery({
    queryKey: ['platform', 'plans', 'admin', scope],
    queryFn: () => platformApi.adminPlans(scope === 'all' ? undefined : scope),
  });

  const posName = (code?: string | null) => (code ? (posProducts?.find((p) => p.code === code)?.name ?? code) : 'Every POS type');

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['platform', 'plans'] });
    void queryClient.invalidateQueries({ queryKey: ['platform', 'pos-products'] });
  };

  const setActive = useMutation({
    mutationFn: ({ plan, active }: { plan: AdminPlan; active: boolean }) =>
      active ? platformApi.updatePlan(plan._id, { isActive: true }) : platformApi.deactivatePlan(plan._id),
    onSuccess: (_result, { plan, active }) => {
      toast.success(active ? `${plan.name} is on sale again` : `${plan.name} withdrawn from sale`);
      setWithdrawing(null);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not change the plan')),
  });

  const columns: Column<AdminPlan>[] = [
    {
      key: 'plan',
      header: 'Plan',
      mobile: 'title',
      cell: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="font-mono text-xs text-muted-foreground">{row.code}</p>
        </div>
      ),
    },
    {
      key: 'pos',
      header: 'POS type',
      cell: (row) => <Badge variant={row.posProductCode ? 'default' : 'secondary'}>{posName(row.posProductCode)}</Badge>,
    },
    {
      key: 'price',
      header: 'Price',
      cell: (row) => (
        <span className="tabular">
          {formatPlanPrice(row.priceMinor, row.currency)}/{per(row.interval)}
        </span>
      ),
    },
    { key: 'tier', header: 'Tier', mobile: 'hide', cell: (row) => <span className="tabular">{row.tier}</span> },
    { key: 'trial', header: 'Trial', mobile: 'hide', cell: (row) => (row.trialDays > 0 ? `${row.trialDays} days` : '—') },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          <Badge variant={row.isActive ? 'success' : 'secondary'}>{row.isActive ? 'On sale' : 'Withdrawn'}</Badge>
          {row.isActive && row.isPublic === false && <Badge variant="warning">Hidden</Badge>}
        </div>
      ),
    },
    { key: 'workspaces', header: 'Workspaces', mobile: 'meta', cell: (row) => <span className="tabular">{row.runningSubscriptions}</span> },
    {
      key: 'actions',
      header: '',
      mobile: 'actions',
      cell: (row) => (
        <div className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <Button size="sm" variant="ghost" onClick={() => setEditing(row)} aria-label={`Edit ${row.name}`}>
            <Pencil />
          </Button>
          {row.isActive ? (
            <Button size="sm" variant="outline" onClick={() => setWithdrawing(row)}>
              Withdraw
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              loading={setActive.isPending && setActive.variables?.plan._id === row._id}
              onClick={() => setActive.mutate({ plan: row, active: true })}
            >
              Restore
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger className="w-56" aria-label="Filter by POS type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All plans</SelectItem>
            <SelectItem value="shared">Shared by every POS type</SelectItem>
            {(posProducts ?? []).map((product) => (
              <SelectItem key={product.code} value={product.code}>
                {product.name} only
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={() => setEditing('new')}>
          <Plus />
          New plan
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={plans ?? []}
        rowKey={(row) => row._id}
        loading={isLoading}
        error={error ? errorMessage(error, 'Could not load plans') : null}
        onRetry={() => void refetch()}
        onRowClick={(row) => setUsageOf(row)}
        emptyTitle="No plans here"
        emptyDescription="Create a plan, or choose another POS type."
      />

      {editing !== null && (
        <PlanEditorDialog
          key={editing === 'new' ? 'new' : editing._id}
          plan={editing === 'new' ? null : editing}
          posProducts={posProducts ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}

      <PlanUsageDialog plan={usageOf} posName={posName} onClose={() => setUsageOf(null)} />

      <ConfirmDialog
        open={withdrawing !== null}
        onOpenChange={(open) => {
          if (!open) setWithdrawing(null);
        }}
        title={`Withdraw ${withdrawing?.name ?? 'this plan'}?`}
        description={
          withdrawing && withdrawing.runningSubscriptions > 0
            ? `No one can buy or renew it any more. The ${withdrawing.runningSubscriptions} workspace(s) on it keep their current period until it ends. You can restore it later.`
            : 'No one can buy it any more. You can restore it later.'
        }
        confirmLabel="Withdraw"
        destructive
        loading={setActive.isPending}
        onConfirm={() => {
          if (withdrawing) setActive.mutate({ plan: withdrawing, active: false });
        }}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------

interface PlanForm {
  code: string;
  name: string;
  description: string;
  posProductCode: string;
  interval: 'monthly' | 'yearly';
  priceMinor: number | null;
  currency: string;
  trialDays: string;
  tier: string;
  sortOrder: string;
  isActive: boolean;
  isPublic: boolean;
  features: Record<string, boolean>;
  limits: Record<string, number>;
}

const formFrom = (plan: AdminPlan | null): PlanForm => ({
  code: plan?.code ?? '',
  name: plan?.name ?? '',
  description: plan?.description ?? '',
  posProductCode: plan?.posProductCode ?? 'shared',
  interval: plan?.interval ?? 'monthly',
  priceMinor: plan?.priceMinor ?? null,
  currency: plan?.currency ?? 'BDT',
  trialDays: String(plan?.trialDays ?? 0),
  tier: String(plan?.tier ?? 1),
  sortOrder: String(plan?.sortOrder ?? 0),
  isActive: plan?.isActive ?? true,
  isPublic: plan?.isPublic ?? true,
  features: { ...DEFAULT_FEATURES, ...(plan?.features ?? {}) },
  limits: { ...DEFAULT_LIMITS, ...(plan?.limits ?? {}) },
});

const wholeNumber = (value: string, max: number) => /^\d+$/.test(value) && Number(value) <= max;

/** The first problem with the form, in words, or null. The server validates again. */
function problemWith(form: PlanForm, isNew: boolean): string | null {
  if (isNew && !/^[a-z0-9-]{2,60}$/.test(form.code)) return 'Code: 2–60 lowercase letters, numbers and dashes.';
  if (form.name.trim().length < 2 || form.name.trim().length > 80) return 'Name: 2–80 characters.';
  if (form.description.length > 300) return 'Description: at most 300 characters.';
  if (form.priceMinor === null) return 'Enter a price (0 for a free plan).';
  if (!/^[A-Z]{3}$/.test(form.currency)) return 'Currency: a 3-letter code such as BDT.';
  // Every free trial lasts 7 days; a plan either offers it or not.
  if (form.trialDays !== '0' && form.trialDays !== '7') return 'Trial days: 0 (no trial) or 7.';
  if (!wholeNumber(form.tier, 100)) return 'Tier: a whole number from 0 to 100.';
  if (!wholeNumber(form.sortOrder, 10_000)) return 'Sort order: a whole number of 0 or more.';
  return null;
}

function PlanEditorDialog({
  plan,
  posProducts,
  onClose,
  onSaved,
}: {
  plan: AdminPlan | null;
  posProducts: PosProduct[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = plan === null;
  const [form, setForm] = React.useState<PlanForm>(() => formFrom(plan));
  const set = <K extends keyof PlanForm>(key: K, value: PlanForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const problem = problemWith(form, isNew);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...(isNew ? { code: form.code } : {}),
        name: form.name.trim(),
        description: form.description.trim(),
        posProductCode: form.posProductCode === 'shared' ? null : form.posProductCode,
        interval: form.interval,
        priceMinor: form.priceMinor,
        currency: form.currency,
        trialDays: Number(form.trialDays),
        tier: Number(form.tier),
        sortOrder: Number(form.sortOrder),
        isActive: form.isActive,
        isPublic: form.isPublic,
        features: form.features,
        limits: form.limits,
      };
      return isNew ? platformApi.createPlan(body) : platformApi.updatePlan(plan._id, body);
    },
    onSuccess: (saved) => {
      toast.success(isNew ? `${saved.name} created` : `${saved.name} saved`);
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not save the plan')),
  });

  const overrides = plan?.verticalOverrides ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'New plan' : `Edit ${plan.name}`}</DialogTitle>
          <DialogDescription>Prices are in {form.currency}. Customers see public plans on the pricing page.</DialogDescription>
        </DialogHeader>

        {!isNew && plan.runningSubscriptions > 0 && (
          <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {plan.runningSubscriptions} workspace(s) run this plan. Changes apply to new purchases and renewals; periods
              already paid keep the price, features and limits they were bought with.
            </span>
          </div>
        )}

        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!problem && !save.isPending) save.mutate();
          }}
        >
          <section className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="plan-code">Code</Label>
              <Input
                id="plan-code"
                className="font-mono"
                value={form.code}
                disabled={!isNew}
                maxLength={60}
                placeholder="restaurant-starter-monthly"
                onChange={(event) => set('code', event.target.value.toLowerCase())}
              />
              {!isNew && <p className="text-xs text-muted-foreground">A plan's code never changes; subscriptions refer to it.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-name">Name</Label>
              <Input id="plan-name" value={form.name} maxLength={80} onChange={(event) => set('name', event.target.value)} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="plan-description">Description</Label>
              <Textarea
                id="plan-description"
                rows={2}
                maxLength={300}
                value={form.description}
                onChange={(event) => set('description', event.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Sold to</Label>
              <Select value={form.posProductCode} onValueChange={(value) => set('posProductCode', value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shared">Every POS type (shared plan)</SelectItem>
                  {posProducts.map((product) => (
                    <SelectItem key={product.code} value={product.code}>
                      {product.name} only{product.status === 'active' ? '' : ' (POS type inactive)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {overrides.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  This plan has per-type settings for {overrides.map((entry) => entry.vertical).join(', ')}. They are kept
                  as they are.
                </p>
              )}
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Price</Label>
              <MoneyInput value={form.priceMinor} onChange={(value) => set('priceMinor', value)} ariaLabel="Plan price" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-currency">Currency</Label>
              <Input
                id="plan-currency"
                maxLength={3}
                value={form.currency}
                onChange={(event) => set('currency', event.target.value.toUpperCase())}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Billed</Label>
              <Select value={form.interval} onValueChange={(value) => set('interval', value as PlanForm['interval'])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <NumberField id="plan-trial" label="Trial days" value={form.trialDays} onChange={(value) => set('trialDays', value)} />
            <NumberField
              id="plan-tier"
              label="Tier"
              hint="Higher is a better plan"
              value={form.tier}
              onChange={(value) => set('tier', value)}
            />
            <NumberField id="plan-sort" label="Sort order" value={form.sortOrder} onChange={(value) => set('sortOrder', value)} />
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <ToggleRow label="On sale" hint="Withdrawn plans cannot be bought or renewed." checked={form.isActive} onChange={(value) => set('isActive', value)} />
            <ToggleRow label="Public" hint="Shown on the pricing page." checked={form.isPublic} onChange={(value) => set('isPublic', value)} />
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">Features</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.keys(DEFAULT_FEATURES).map((key) => (
                <ToggleRow
                  key={key}
                  label={FEATURE_LABELS[key] ?? key}
                  checked={form.features[key] === true}
                  onChange={(value) => set('features', { ...form.features, [key]: value })}
                />
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">Limits</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {LIMIT_FIELDS.map((field) => (
                <LimitField
                  key={field.key}
                  label={field.label}
                  bytes={field.bytes}
                  value={form.limits[field.key] ?? -1}
                  onChange={(value) => set('limits', { ...form.limits, [field.key]: value })}
                />
              ))}
            </div>
          </section>

          {problem && <p className="text-sm text-destructive">{problem}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={problem !== null} loading={save.isPending}>
              {isNew ? 'Create plan' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NumberField({ id, label, hint, value, onChange }: { id: string; label: string; hint?: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode="numeric" value={value} onChange={(event) => onChange(event.target.value.replace(/\D/g, ''))} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <div>
        <p className="text-sm">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

/** A limit: a whole number, or unlimited (stored as -1). Storage is edited in MB and stored in bytes. */
function LimitField({ label, bytes, value, onChange }: { label: string; bytes?: boolean; value: number; onChange: (value: number) => void }) {
  const unlimited = value === -1;
  const shown = unlimited ? '' : String(bytes ? Math.round(value / MB) : value);
  return (
    <div className="space-y-1.5 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label>
          {label}
          {bytes ? ' (MB)' : ''}
        </Label>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          Unlimited
          <Switch
            checked={unlimited}
            onCheckedChange={(checked) => onChange(checked ? -1 : bytes ? 1024 * MB : 0)}
            aria-label={`${label}: unlimited`}
          />
        </span>
      </div>
      <Input
        inputMode="numeric"
        disabled={unlimited}
        value={shown}
        placeholder={unlimited ? 'Unlimited' : '0'}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, '').slice(0, 9);
          const number = digits === '' ? 0 : Number(digits);
          onChange(bytes ? number * MB : number);
        }}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------

function PlanUsageDialog({
  plan,
  posName,
  onClose,
}: {
  plan: AdminPlan | null;
  posName: (code?: string | null) => string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['platform', 'plans', 'usage', plan?._id],
    queryFn: () => platformApi.planUsage(plan!._id),
    enabled: plan !== null,
  });

  return (
    <Dialog open={plan !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{plan?.name ?? 'Plan'}</DialogTitle>
          <DialogDescription>
            {plan ? `${formatPlanPrice(plan.priceMinor, plan.currency)}/${per(plan.interval)} · ${posName(plan.posProductCode)}` : ''}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !data ? (
          <LoadingState label="Loading who is on this plan…" />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Running" value={data.runningCount} />
              <Stat label="Ended" value={data.subscriptionsByStatus.expired ?? 0} />
              <Stat label="Pending payments" value={data.pendingPayments} />
              <Stat label="Pending requests" value={data.pendingRequests} />
            </div>

            {data.workspaces.length === 0 ? (
              <p className="text-sm text-muted-foreground">No workspace is on this plan right now.</p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Workspace</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Period ends</th>
                      <th className="px-3 py-2 font-medium">Paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.workspaces.map((row) => (
                      <tr key={row.subscriptionId} className="border-t">
                        <td className="px-3 py-2">
                          {row.tenantId ? (
                            <button
                              type="button"
                              className="font-medium hover:underline"
                              onClick={() => navigate(`/platform/workspaces/${row.tenantId}`)}
                            >
                              {row.name}
                            </button>
                          ) : (
                            <span className="text-muted-foreground">{row.name}</span>
                          )}
                          <p className="text-xs text-muted-foreground">{posName(row.vertical)}</p>
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={row.status === 'past_due' || row.status === 'cancelled' ? 'warning' : 'success'}>
                            {STATUS_LABELS[row.status] ?? row.status}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 tabular">{format(new Date(row.currentPeriodEnd), 'd MMM yyyy')}</td>
                        <td className="px-3 py-2 tabular">
                          {row.priceMinor !== null ? formatPlanPrice(row.priceMinor, row.currency ?? 'BDT') : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.runningCount > data.workspaces.length && (
              <p className="text-xs text-muted-foreground">Showing the first {data.workspaces.length} of {data.runningCount}.</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular">{value}</p>
    </div>
  );
}
