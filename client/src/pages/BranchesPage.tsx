import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { LimitAlert } from '@/components/LimitAlert';
import { PermissionGate } from '@/components/PermissionGate';
import { ApiError } from '@/api/client';
import { supershopApi } from '@/api/supershop';
import { billingApi, reportApi, storeApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import { useValidatedForm } from '@/hooks/useValidatedForm';
import { FieldError } from '@/components/FieldError';
import { optionalPhoneField, optionalText, requiredText } from '@/lib/validation';
import { z } from 'zod';
import { cn } from '@/lib/utils';
import type { StoreSettings } from '@/types/domain';

/**
 * Branch management for the store owner.
 *
 * Creation is gated by the plan's `maxStores`; the backend enforces it, and
 * this screen shows how much headroom is left rather than failing at submit.
 */
export function BranchesPage() {
  const { activeStore, setActiveStore, refresh, session } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const [editing, setEditing] = React.useState<StoreSettings | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<StoreSettings | null>(null);
  const queryClient = useQueryClient();

  const { data: stores, isLoading } = useQuery({ queryKey: ['stores'], queryFn: storeApi.list });
  const { data: subscription } = useQuery({ queryKey: ['subscription', 'current'], queryFn: billingApi.current });
  // Each vertical answers this from its own sales, with its own arithmetic.
  // Clothing adds VAT on top of its prices; a Super Shop price includes it, so
  // the two work profit out differently and must not share an endpoint.
  const vertical = session?.tenant?.vertical ?? 'clothing';
  const isSupershop = vertical === 'supershop';

  const { data: branchReport } = useQuery({
    queryKey: ['report', 'branches', 'page'],
    queryFn: () => reportApi.branches({ preset: 'last30', branch: 'all' }),
    enabled: !isSupershop,
    retry: false,
  });
  const { data: shopBranches, isLoading: shopBranchesLoading, error: shopBranchesError } = useQuery({
    queryKey: ['supershop', 'branches-overview'],
    queryFn: () => supershopApi.branchOverview(),
    enabled: isSupershop,
    retry: false,
  });

  const remove = useMutation({
    mutationFn: (id: string) => storeApi.remove(id),
    onSuccess: (result) => {
      toast.success('Branch deleted', {
        description:
          result.historicalSalesPreserved > 0
            ? `${result.historicalSalesPreserved} past sale(s) kept intact.`
            : 'Its history remains intact.',
      });
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: ['stores'] });
      void refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not delete the branch'),
  });

  const promote = useMutation({
    mutationFn: (id: string) => storeApi.makeDefault(id),
    onSuccess: () => {
      toast.success('Main branch updated');
      void queryClient.invalidateQueries({ queryKey: ['stores'] });
      void refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not update the main branch'),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => storeApi.update(id, { isActive }),
    onSuccess: () => {
      toast.success('Branch updated');
      void queryClient.invalidateQueries({ queryKey: ['stores'] });
      void refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not update the branch'),
  });

  if (isLoading || !stores) return <LoadingState label="Loading branches…" />;

  const maxStores = subscription?.entitlement.limits.maxStores ?? 1;
  const unlimited = maxStores === -1;
  const atLimit = !unlimited && stores.length >= maxStores;
  const statsFor = (id: string) => branchReport?.rows.find((r) => String(r.id) === String(id));
  const shopStatsFor = (id: string) => shopBranches?.rows.find((r) => String(r.id) === String(id));
  // Only an administrator may compare branches; for anyone else the server
  // refuses and the cards simply carry no figures, as they always have.
  const shopOverviewDenied = shopBranchesError instanceof ApiError && shopBranchesError.status === 403;

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Branches & stores"
        description={`${stores.length} of ${unlimited ? 'unlimited' : maxStores} branch${maxStores === 1 ? '' : 'es'} used on the ${subscription?.entitlement.planName ?? 'current'} plan.`}
        actions={
          <PermissionGate anyOf={['settings.edit']}>
            <Button onClick={() => setCreating(true)} disabled={atLimit}>
              {atLimit ? <Lock /> : <Plus />}
              {atLimit ? 'Branch limit reached' : 'New branch'}
            </Button>
          </PermissionGate>
        }
      />
      <LimitAlert resource="stores" />

      {atLimit && (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="p-4 text-sm text-warning">
            Your plan allows {maxStores} branch{maxStores === 1 ? '' : 'es'}. Upgrade to add more.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {stores.map((store) => {
          const stats = statsFor(store._id);
          const shopStats = shopStatsFor(store._id);
          const isCurrent = String(activeStore?.id) === String(store._id);

          return (
            <Card key={store._id} className={cn(isCurrent && 'border-primary ring-1 ring-primary', !store.isActive && 'opacity-70')}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Building2 className="h-4 w-4 shrink-0" />
                      <span className="truncate">{store.name}</span>
                    </CardTitle>
                    <CardDescription className="font-mono text-xs">{store.code}</CardDescription>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {store.isDefault && <Badge variant="secondary">Main</Badge>}
                    {!store.isActive && <Badge variant="destructive">Inactive</Badge>}
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                <div className="space-y-0.5 text-sm text-muted-foreground">
                  {store.address && <p className="truncate">{store.address}</p>}
                  {store.phone && <p>{store.phone}</p>}
                </div>

                {stats && (
                  <dl className="grid grid-cols-2 gap-2 border-t pt-3 text-sm">
                    <Metric label="Sales (30d)" value={formatMoney(stats.netSalesMinor, currency)} />
                    <Metric label="Profit (30d)" value={formatMoney(stats.profitMinor, currency)} />
                    <Metric label="Orders" value={String(stats.orders)} />
                    <Metric label="Stock value" value={formatMoney(stats.stockValueMinor, currency)} />
                  </dl>
                )}

                {/* Super Shop's own last-30-days line: net of refunds, with VAT
                    taken out of profit because its prices include it. */}
                {isSupershop && shopBranchesLoading && <p className="border-t pt-3 text-xs text-muted-foreground">Loading the last 30 days…</p>}
                {isSupershop && shopStats && (
                  <dl className="grid grid-cols-2 gap-2 border-t pt-3 text-sm">
                    <Metric label="Net sales (30d)" value={formatMoney(shopStats.netSalesMinor, currency)} />
                    <Metric label="Profit (30d)" value={formatMoney(shopStats.grossProfitMinor, currency)} />
                    <Metric label="Sales" value={String(shopStats.salesCount)} />
                    <Metric label="Refunded" value={formatMoney(shopStats.returnAmountMinor, currency)} />
                    <Metric label="Average basket" value={formatMoney(shopStats.averageBasketMinor, currency)} />
                    <Metric label="Stock value" value={formatMoney(shopStats.stockValueMinor, currency)} />
                  </dl>
                )}
                {isSupershop && !shopBranchesLoading && !shopStats && !shopOverviewDenied && (
                  <p className="border-t pt-3 text-xs text-muted-foreground">Nothing sold here in the last 30 days.</p>
                )}

                <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                  {!isCurrent && store.isActive && (
                    <Button variant="outline" size="sm" onClick={() => setActiveStore(store._id)}>
                      Switch to branch
                    </Button>
                  )}

                  <PermissionGate anyOf={['settings.edit']}>
                    <>
                      <Button variant="ghost" size="icon-sm" onClick={() => setEditing(store)} aria-label={`Edit ${store.name}`}>
                        <Pencil />
                      </Button>

                      {!store.isDefault && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleActive.mutate({ id: store._id, isActive: !store.isActive })}
                          >
                            {store.isActive ? 'Deactivate' : 'Activate'}
                          </Button>

                          {store.isActive && (
                            <Button variant="ghost" size="sm" onClick={() => promote.mutate(store._id)}>
                              Make main
                            </Button>
                          )}

                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="ml-auto text-muted-foreground hover:text-destructive"
                            onClick={() => setDeleting(store)}
                            aria-label={`Delete ${store.name}`}
                          >
                            <Trash2 />
                          </Button>
                        </>
                      )}
                    </>
                  </PermissionGate>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete "${deleting?.name}"?`}
        description={
          <span>
            The branch is removed from your workspace, but <strong>its sales, returns and stock history are kept</strong>{' '}
            so past reports stay accurate. Any staff based here move to your main branch.
          </span>
        }
        confirmLabel="Delete branch"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting._id);
        }}
      />

      <BranchDialog
        open={creating || Boolean(editing)}
        store={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => void refresh()}
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular font-medium">{value}</dd>
    </div>
  );
}

function BranchDialog({
  open,
  store,
  onClose,
  onSaved,
}: {
  open: boolean;
  store: StoreSettings | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState({ name: '', code: '', phone: '', address: '', isActive: true });

  // The branch code becomes part of every invoice number, so it has to be
  // storable as-is: letters and digits only.
  const schema = React.useMemo(
    () =>
      z.object({
        name: requiredText('Branch name', 120).refine((v) => v.length >= 2, 'Branch name is too short'),
        code: z
          .string()
          .trim()
          .max(12, 'Code is too long')
          .refine((v) => v === '' || /^[A-Z0-9]+$/.test(v), 'Use letters and numbers only')
          .optional()
          .default(''),
        phone: optionalPhoneField,
        address: optionalText(300),
      }),
    [],
  );
  const validation = useValidatedForm(schema, form);

  React.useEffect(() => {
    if (!open) return;
    setForm(
      store
        ? { name: store.name, code: store.code, phone: store.phone, address: store.address, isActive: store.isActive }
        : { name: '', code: '', phone: '', address: '', isActive: true },
    );
  }, [open, store]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        ...(form.code.trim() ? { code: form.code.trim().toUpperCase() } : {}),
      };
      return store ? storeApi.update(store._id, payload) : storeApi.create({ ...payload, currency: 'BDT' });
    },
    onSuccess: () => {
      toast.success(store ? 'Branch updated' : 'Branch created');
      onClose();
      onSaved();
      void queryClient.invalidateQueries({ queryKey: ['stores'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the branch'),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{store ? `Edit ${store.name}` : 'New branch'}</DialogTitle>
          <DialogDescription>
            Each branch keeps its own stock, staff and sales. Reports can be viewed per branch or combined.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Branch name</Label>
              <Input
                autoFocus
                value={form.name}
                onBlur={() => validation.touch('name')}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
              <FieldError message={validation.errorFor('name')} />
            </div>
            <div className="space-y-1.5">
              <Label>Code</Label>
              <Input
                value={form.code}
                onBlur={() => validation.touch('code')}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                placeholder="Auto-generated if blank"
              />
              <FieldError message={validation.errorFor('code')} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Phone</Label>
            <Input
              inputMode="tel"
              value={form.phone}
              onBlur={() => validation.touch('phone')}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
            <FieldError message={validation.errorFor('phone')} />
          </div>

          <div className="space-y-1.5">
            <Label>Address</Label>
            <Textarea rows={2} value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
          </div>

          {store && !store.isDefault && (
            <label className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label>Active</Label>
                <p className="text-xs text-muted-foreground">Inactive branches cannot be used for sales</p>
              </div>
              <Switch checked={form.isActive} onCheckedChange={(v) => setForm((f) => ({ ...f, isActive: v }))} />
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            loading={save.isPending}
            onClick={() => (validation.valid ? save.mutate() : validation.touchAll())}
          >
            {store ? 'Save changes' : 'Create branch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
