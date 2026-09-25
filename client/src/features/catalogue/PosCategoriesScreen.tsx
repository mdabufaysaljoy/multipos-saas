import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { ApiError } from '@/api/client';
import type { PosCategoryRow, posCategoriesApi } from '@/api/posCategories';

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

interface PosCategoriesScreenProps {
  title: string;
  description: string;
  /** What this vertical calls the things in a category: "product", "medicine", "dish". */
  noun: { one: string; many: string };
  api: ReturnType<typeof posCategoriesApi>;
  /** Query keys to refresh when a name changes; renaming rewrites the items too. */
  invalidate: string[];
  /**
   * What one of these names IS, in the wording of the screen: "category" by
   * default, "brand" for Super Shop's brand list. Optional so every existing
   * caller reads exactly as it did.
   */
  entityLabel?: string;
  /** The server's own limit on the name. 60 for a category, 80 for a brand. */
  maxNameLength?: number;
}

/**
 * Managing the departments a workspace sells under, for the POS types whose
 * items carry the category as a NAME (Super Shop, Pharmacy, Restaurant).
 *
 * Renaming rewrites every item that carries the old name; past sales keep the
 * name they were sold under. A name still in use cannot be removed - hiding it
 * is how a department is retired without touching what already sits in it.
 */
export function PosCategoriesScreen({ title, description, noun, api, invalidate, entityLabel = 'category', maxNameLength = 60 }: PosCategoriesScreenProps) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState<PosCategoryRow | 'new' | null>(null);
  const [deleting, setDeleting] = React.useState<PosCategoryRow | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [...invalidate, 'categories', 'manage'],
    queryFn: () => api.list(true),
  });

  const refresh = () => invalidate.forEach((key) => void queryClient.invalidateQueries({ queryKey: [key] }));

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.update(id, { isActive }),
    onSuccess: (_row, variables) => {
      toast.success(variables.isActive ? 'Category is offered again' : 'Category hidden from the till');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not change the category')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.remove(id),
    onSuccess: () => {
      toast.success('Category removed');
      setDeleting(null);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not remove the category')),
  });

  const columns: Column<PosCategoryRow>[] = [
    {
      key: 'name',
      header: 'Category',
      mobile: 'title',
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{row.name}</span>
          {!row.isActive && <Badge variant="secondary">Hidden</Badge>}
          {row.id === null && <Badge variant="outline">In use</Badge>}
        </div>
      ),
    },
    {
      key: 'items',
      header: noun.many[0].toUpperCase() + noun.many.slice(1),
      cell: (row) => <span className="tabular">{row.itemCount}</span>,
    },
    { key: 'order', header: 'Order', mobile: 'hide', cell: (row) => <span className="tabular text-muted-foreground">{row.sortOrder || '—'}</span> },
    {
      key: 'actions',
      header: '',
      mobile: 'actions',
      className: 'text-right',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <PermissionGate anyOf={['categories.edit']}>
            <Button variant="ghost" size="icon-sm" onClick={() => setEditing(row)} aria-label={`Rename ${row.name}`}>
              <Pencil />
            </Button>
            {row.id && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setActive.mutate({ id: row.id!, isActive: !row.isActive })}
                aria-label={row.isActive ? `Hide ${row.name}` : `Show ${row.name}`}
              >
                {row.isActive ? <EyeOff /> : <Eye />}
              </Button>
            )}
          </PermissionGate>
          <PermissionGate anyOf={['categories.delete']}>
            {row.id && (
              <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(row)} aria-label={`Remove ${row.name}`}>
                <Trash2 />
              </Button>
            )}
          </PermissionGate>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader
        title={title}
        description={description}
        actions={
          <PermissionGate anyOf={['categories.create']}>
            <Button onClick={() => setEditing('new')}>
              <Plus />
              Add category
            </Button>
          </PermissionGate>
        }
      />

      <Card>
        <DataTable
          columns={columns}
          rows={data ?? []}
          rowKey={(row) => row.id ?? row.slug}
          loading={isLoading}
          error={error ? errorMessage(error, 'Could not load the categories') : null}
          onRetry={() => void refetch()}
          emptyTitle="No categories yet"
          emptyDescription={`Add one, or simply give a ${noun.one} a category and it appears here.`}
        />
      </Card>

      {editing !== null && (
        <CategoryDialog
          key={editing === 'new' ? 'new' : (editing.id ?? editing.slug)}
          category={editing === 'new' ? null : editing}
          noun={noun}
          api={api}
          entityLabel={entityLabel}
          maxNameLength={maxNameLength}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Remove ${deleting?.name ?? entityLabel}?`}
        description={`Only possible while no ${noun.one} uses it. Past sales keep the name they were sold under.`}
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting?.id) remove.mutate(deleting.id);
        }}
      />
    </div>
  );
}

/**
 * Adding a category, or renaming one. A name that items already use has no row
 * of its own yet, so renaming it writes one first and then renames it - the
 * shopkeeper never has to know the difference.
 */
function CategoryDialog({
  category,
  noun,
  api,
  onClose,
  onSaved,
  entityLabel = 'category',
  maxNameLength = 60,
}: {
  category: PosCategoryRow | null;
  noun: { one: string; many: string };
  api: ReturnType<typeof posCategoriesApi>;
  onClose: () => void;
  onSaved: () => void;
  entityLabel?: string;
  maxNameLength?: number;
}) {
  const [name, setName] = React.useState(category?.name ?? '');
  const [sortOrder, setSortOrder] = React.useState(String(category?.sortOrder ?? 0));

  const save = useMutation({
    mutationFn: async () => {
      const order = Number(sortOrder) || 0;
      if (!category) return api.create({ name: name.trim(), sortOrder: order });
      const id = category.id ?? (await api.create({ name: category.name, sortOrder: category.sortOrder })).id;
      if (!id) throw new ApiError('UNKNOWN', `Could not save the ${entityLabel}`, 500);
      return api.update(id, { name: name.trim(), sortOrder: order });
    },
    onSuccess: () => {
      toast.success(category ? `Renamed to ${name.trim()}` : `${name.trim()} added`);
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err, `Could not save the ${entityLabel}`)),
  });

  const valid = name.trim().length > 0 && name.trim().length <= maxNameLength;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{category ? `Rename ${category.name}` : `Add ${entityLabel}`}</DialogTitle>
          <DialogDescription>
            {category && category.itemCount > 0
              ? `${category.itemCount} ${category.itemCount === 1 ? noun.one : noun.many} will be moved to the new name. Past sales keep the old one.`
              : `A ${entityLabel} groups the ${noun.many} on the till.`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
          <div className="space-y-1.5">
            <Label htmlFor="category-name">Name</Label>
            <Input id="category-name" autoFocus value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="category-order">Order</Label>
            <Input id="category-order" value={sortOrder} inputMode="numeric" maxLength={4} onChange={(event) => setSortOrder(event.target.value.replace(/\D/g, ''))} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Lower numbers come first on the till; equal numbers sort by name.</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {category ? 'Save' : 'Add category'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
