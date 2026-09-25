import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2, UtensilsCrossed } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { MoneyInput } from '@/components/MoneyInput';
import { PageHeader } from '@/components/PageHeader';
import { LimitAlert } from '@/components/LimitAlert';
import { PermissionGate } from '@/components/PermissionGate';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { ApiError } from '@/api/client';
import { restaurantApi } from '@/api/restaurant';
import { restaurantCategoriesApi } from '@/api/posCategories';
import { CategoryInput } from '@/features/catalogue/CategoryInput';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import type { MenuItem } from '@/types/restaurant';

interface Draft {
  name: string;
  category: string;
  description: string;
  priceMinor: number | null;
  isAvailable: boolean;
}

const EMPTY: Draft = { name: '', category: 'General', description: '', priceMinor: null, isAvailable: true };

/** The restaurant menu: shared by every branch of the workspace. */
export function MenuPage() {
  const { activeStore, can } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const queryClient = useQueryClient();
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term);
  const [editing, setEditing] = React.useState<MenuItem | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<MenuItem | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['restaurant', 'menu', search],
    queryFn: () => restaurantApi.menu({ limit: 100, ...(search ? { search } : {}) }),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['restaurant'] });

  const toggle = useMutation({
    mutationFn: (item: MenuItem) => restaurantApi.updateMenuItem(item._id, { isAvailable: !item.isAvailable }),
    onSuccess: refresh,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not update the item'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => restaurantApi.removeMenuItem(id),
    onSuccess: () => {
      toast.success('Removed from the menu', { description: 'Past orders keep their details.' });
      setDeleting(null);
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not remove the item'),
  });

  const columns: Column<MenuItem>[] = [
    {
      key: 'name',
      header: 'Item',
      mobile: 'title',
      cell: (item) => (
        <div>
          <p className="font-medium">{item.name}</p>
          {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
        </div>
      ),
    },
    { key: 'category', header: 'Category', mobile: 'meta', cell: (item) => item.category },
    {
      key: 'price',
      header: 'Price',
      className: 'text-right',
      headerClassName: 'text-right',
      cell: (item) => <span className="tabular font-medium">{formatMoney(item.priceMinor, currency)}</span>,
    },
    {
      key: 'available',
      header: 'Available',
      cell: (item) =>
        can('products.edit') ? (
          <Switch checked={item.isAvailable} onCheckedChange={() => toggle.mutate(item)} aria-label={`${item.name} available`} />
        ) : (
          <Badge variant={item.isAvailable ? 'success' : 'secondary'}>{item.isAvailable ? 'Yes' : 'No'}</Badge>
        ),
    },
    {
      key: 'actions',
      header: '',
      mobile: 'actions',
      className: 'text-right',
      cell: (item) => (
        <div className="flex justify-end gap-1">
          <PermissionGate anyOf={['products.edit']}>
            <Button variant="ghost" size="icon-sm" onClick={() => setEditing(item)} aria-label={`Edit ${item.name}`}>
              <Pencil />
            </Button>
          </PermissionGate>
          <PermissionGate anyOf={['products.delete']}>
            <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(item)} aria-label={`Remove ${item.name}`}>
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
        title="Menu"
        description="Dishes and drinks for every branch. Prices here are what orders are charged."
        actions={
          <PermissionGate anyOf={['products.create']}>
            <Button onClick={() => setCreating(true)}>
              <Plus />
              Add item
            </Button>
          </PermissionGate>
        }
      />
      <LimitAlert resource="products" />

      <Card>
        <div className="border-b p-3">
          <SearchInput value={term} onChange={setTerm} placeholder="Search the menu…" className="w-full sm:max-w-xs" />
        </div>
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(item) => item._id}
          loading={isLoading}
          error={error instanceof Error ? error.message : null}
          onRetry={() => void refetch()}
          emptyTitle="Your menu is empty"
          emptyDescription="Add the dishes and drinks you sell."
        />
      </Card>

      <MenuItemDialog
        open={creating || Boolean(editing)}
        item={editing}
        currency={currency}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        onSaved={refresh}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Remove ${deleting?.name ?? 'item'}?`}
        description="It will no longer be orderable. Orders that already include it are unchanged."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting._id);
        }}
      />
    </div>
  );
}

function MenuItemDialog({
  open,
  item,
  currency,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  item: MenuItem | null;
  currency: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = React.useState<Draft>(EMPTY);

  React.useEffect(() => {
    if (open) {
      setDraft(
        item
          ? { name: item.name, category: item.category, description: item.description, priceMinor: item.priceMinor, isAvailable: item.isAvailable }
          : EMPTY,
      );
    }
  }, [open, item]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: draft.name.trim(),
        category: draft.category.trim() || 'General',
        description: draft.description.trim(),
        priceMinor: draft.priceMinor ?? 0,
        isAvailable: draft.isAvailable,
      };
      return item ? restaurantApi.updateMenuItem(item._id, body) : restaurantApi.createMenuItem(body);
    },
    onSuccess: () => {
      toast.success(item ? 'Menu item updated' : 'Added to the menu');
      onOpenChange(false);
      onSaved();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the item'),
  });

  const valid = draft.name.trim().length > 0 && draft.priceMinor !== null && draft.priceMinor >= 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UtensilsCrossed className="h-4 w-4" />
            {item ? 'Edit menu item' : 'New menu item'}
          </DialogTitle>
          <DialogDescription>Changing a price affects new order lines only.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="menu-name">Name</Label>
            <Input id="menu-name" value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <CategoryInput
              id="menu-category"
              label="Section"
              value={draft.category}
              onChange={(category) => setDraft({ ...draft, category })}
              api={restaurantCategoriesApi}
              queryKey="restaurant"
            />
            <div className="space-y-1.5">
              <Label>Price</Label>
              <MoneyInput value={draft.priceMinor} onChange={(priceMinor) => setDraft({ ...draft, priceMinor })} ariaLabel="Price" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="menu-description">Description</Label>
            <Input
              id="menu-description"
              value={draft.description}
              maxLength={300}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Optional"
            />
          </div>
          <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
            <span>
              Available to order
              <span className="block text-xs text-muted-foreground">Turn off when it runs out.</span>
            </span>
            <Switch checked={draft.isAvailable} onCheckedChange={(isAvailable) => setDraft({ ...draft, isAvailable })} />
          </label>
          <p className="text-xs text-muted-foreground">Prices are in {currency}.</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {item ? 'Save changes' : 'Add item'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
