import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { MoneyInput } from '@/components/MoneyInput';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { ApiError } from '@/api/client';
import { restaurantApi } from '@/api/restaurant';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import type { MenuAddOnRow } from '@/types/restaurant';

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * The workspace's reusable extras: Extra cheese, Extra sauce, Extra drink.
 *
 * Defined once here and picked on any dish, so a kitchen never retypes them.
 * The price here is what a dish SUGGESTS when the extra is picked - each dish
 * keeps its own copy, because the same extra is worth different money on a
 * pizza and on a burger, and because a menu edit must never quietly reprice
 * what is already being sold.
 */
export function MenuAddOnsPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState<MenuAddOnRow | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<MenuAddOnRow | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['restaurant', 'addons', 'all'],
    queryFn: () => restaurantApi.addOns({ includeInactive: 'true' }),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['restaurant'] });

  const toggle = useMutation({
    mutationFn: (row: MenuAddOnRow) => restaurantApi.updateAddOn(row.id, { isActive: !row.isActive }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err, 'Could not update the extra')),
  });

  const remove = useMutation({
    mutationFn: (row: MenuAddOnRow) => restaurantApi.removeAddOn(row.id),
    onSuccess: () => {
      toast.success('Extra removed');
      setDeleting(null);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not remove the extra')),
  });

  const columns: Column<MenuAddOnRow>[] = [
    {
      key: 'name',
      header: 'Extra',
      mobile: 'title',
      cell: (row) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{row.name}</span>
          {!row.isActive && <Badge variant="secondary">Hidden</Badge>}
        </span>
      ),
    },
    {
      key: 'price',
      header: 'Usual price',
      className: 'text-right',
      headerClassName: 'text-right',
      cell: (row) => <span className="tabular font-medium">+ {formatMoney(row.defaultPriceMinor, currency)}</span>,
    },
    {
      key: 'used',
      header: 'On dishes',
      mobile: 'meta',
      cell: (row) => `${row.itemCount} dish${row.itemCount === 1 ? '' : 'es'}`,
    },
    {
      key: 'actions',
      header: '',
      mobile: 'actions',
      className: 'text-right',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <PermissionGate anyOf={['products.edit']}>
            <Button variant="ghost" size="icon-sm" onClick={() => setEditing(row)} aria-label={`Edit ${row.name}`}>
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => toggle.mutate(row)}
              aria-label={`${row.isActive ? 'Hide' : 'Show'} ${row.name}`}
            >
              {row.isActive ? <EyeOff /> : <Eye />}
            </Button>
          </PermissionGate>
          <PermissionGate anyOf={['products.delete']}>
            <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(row)} aria-label={`Remove ${row.name}`}>
              <Trash2 />
            </Button>
          </PermissionGate>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader
        title="Extras"
        description="Things a guest can add to a dish. Define one here and pick it on any dish; each dish keeps its own price, so past orders never change."
        actions={
          <PermissionGate anyOf={['products.create']}>
            <Button onClick={() => setCreating(true)}>
              <Plus />
              New extra
            </Button>
          </PermissionGate>
        }
      />

      <DataTable
        columns={columns}
        rows={data ?? []}
        rowKey={(row) => row.id}
        loading={isLoading}
        error={error instanceof Error ? error.message : null}
        onRetry={() => void refetch()}
        emptyTitle="No extras yet"
        emptyDescription="Add one here, or type one straight onto a dish - it joins this list either way."
      />

      <AddOnDialog open={creating} row={null} currency={currency} onOpenChange={setCreating} onSaved={refresh} />
      <AddOnDialog
        open={Boolean(editing)}
        row={editing}
        currency={currency}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={refresh}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Remove ${deleting?.name ?? ''}?`}
        description="Dishes already offering it must have it taken off first. Past orders are never changed."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting);
        }}
      />
    </div>
  );
}

function AddOnDialog({
  open,
  row,
  currency,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  row: MenuAddOnRow | null;
  currency: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState('');
  const [priceMinor, setPriceMinor] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (open) {
      setName(row?.name ?? '');
      setPriceMinor(row?.defaultPriceMinor ?? null);
    }
  }, [open, row]);

  const save = useMutation({
    mutationFn: () =>
      row
        ? restaurantApi.updateAddOn(row.id, { name: name.trim(), defaultPriceMinor: priceMinor ?? 0 })
        : restaurantApi.createAddOn({ name: name.trim(), defaultPriceMinor: priceMinor ?? 0 }),
    onSuccess: () => {
      toast.success(row ? 'Extra updated' : 'Extra added');
      onOpenChange(false);
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not save the extra')),
  });

  const valid = name.trim().length > 0 && priceMinor !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{row ? `Edit ${row.name}` : 'New extra'}</DialogTitle>
          <DialogDescription>
            {row
              ? 'Renaming it renames it on every dish that offers it. Changing the price only changes what the next dish suggests.'
              : 'It can be picked on any dish afterwards.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="addon-name">Name</Label>
            <Input id="addon-name" value={name} maxLength={60} placeholder="Extra cheese" onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Usual price</Label>
            <MoneyInput value={priceMinor} onChange={setPriceMinor} ariaLabel="Usual price" />
            <p className="text-xs text-muted-foreground">Prices are in {currency}. A dish may charge something else.</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {row ? 'Save' : 'Add extra'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
