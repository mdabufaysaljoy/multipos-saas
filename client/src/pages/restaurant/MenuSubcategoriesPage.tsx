import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { CategoryInput } from '@/features/catalogue/CategoryInput';
import { ApiError } from '@/api/client';
import { restaurantApi } from '@/api/restaurant';
import { restaurantCategoriesApi } from '@/api/posCategories';
import type { MenuSubcategoryRow } from '@/types/restaurant';

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * The subsections of each menu section: Pizza -> Italian, Mexican, Naga Hot.
 *
 * Restaurant's own screen rather than the shared `PosCategoriesScreen`, because
 * a subsection belongs to a SECTION and that screen's four calls have no room
 * for a parent. Bending it would have changed Super Shop and Pharmacy too.
 *
 * Renaming one moves every dish that carries it; past orders keep the name they
 * were sold under. A name still in use cannot be deleted, only hidden.
 */
export function MenuSubcategoriesPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState<MenuSubcategoryRow | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<MenuSubcategoryRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['restaurant', 'subcategories', 'all'],
    queryFn: () => restaurantApi.subcategories({ includeInactive: 'true' }),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['restaurant'] });

  const toggle = useMutation({
    mutationFn: (row: MenuSubcategoryRow) => restaurantApi.updateSubcategory(row.id!, { isActive: !row.isActive }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err, 'Could not update the subsection')),
  });

  const remove = useMutation({
    mutationFn: (row: MenuSubcategoryRow) => restaurantApi.removeSubcategory(row.id!),
    onSuccess: () => {
      toast.success('Subsection removed');
      setDeleting(null);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not remove the subsection')),
  });

  // Grouped the way the menu reads: one block per section.
  const sections = React.useMemo(() => {
    const map = new Map<string, MenuSubcategoryRow[]>();
    for (const row of data ?? []) {
      map.set(row.category, [...(map.get(row.category) ?? []), row]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader
        title="Menu subsections"
        description="One level below a section: Pizza → Italian, Mexican, Naga Hot. Renaming one moves every dish that carries it; past orders keep the old name."
        actions={
          <PermissionGate anyOf={['categories.create']}>
            <Button onClick={() => setCreating(true)}>
              <Plus />
              New subsection
            </Button>
          </PermissionGate>
        }
      />

      {isLoading && <LoadingState label="Loading subsections…" />}
      {!isLoading && sections.length === 0 && (
        <EmptyState
          title="No subsections yet"
          description="Most dishes sit straight under their section. Add a subsection when one section needs splitting up."
        />
      )}

      <div className="space-y-4">
        {sections.map(([section, rows]) => (
          <Card key={section} className="p-4">
            <p className="mb-2 text-sm font-semibold">{section}</p>
            <ul className="divide-y">
              {rows.map((row) => (
                <li key={`${section}/${row.slug}`} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
                  {!row.isActive && <Badge variant="secondary">Hidden</Badge>}
                  <span className="text-xs text-muted-foreground">
                    {row.itemCount} dish{row.itemCount === 1 ? '' : 'es'}
                  </span>
                  {/* A name dishes use but that was never written down has no
                      id yet; saving it once from the dish form gives it one. */}
                  {row.id && (
                    <div className="flex gap-1">
                      <PermissionGate anyOf={['categories.edit']}>
                        <Button variant="ghost" size="icon-sm" onClick={() => setEditing(row)} aria-label={`Rename ${row.name}`}>
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
                      <PermissionGate anyOf={['categories.delete']}>
                        <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(row)} aria-label={`Remove ${row.name}`}>
                          <Trash2 />
                        </Button>
                      </PermissionGate>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>

      <SubcategoryDialog open={creating} row={null} onOpenChange={setCreating} onSaved={refresh} />
      <SubcategoryDialog open={Boolean(editing)} row={editing} onOpenChange={(open) => !open && setEditing(null)} onSaved={refresh} />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Remove ${deleting?.name ?? ''}?`}
        description="Dishes already using it must be moved first. Past orders are never changed."
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

function SubcategoryDialog({
  open,
  row,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  row: MenuSubcategoryRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [category, setCategory] = React.useState('');
  const [name, setName] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setCategory(row?.category ?? '');
      setName(row?.name ?? '');
    }
  }, [open, row]);

  const save = useMutation({
    mutationFn: () =>
      row?.id
        ? restaurantApi.updateSubcategory(row.id, { name: name.trim() })
        : restaurantApi.createSubcategory({ category: category.trim(), name: name.trim() }),
    onSuccess: () => {
      toast.success(row ? 'Subsection renamed' : 'Subsection added');
      onOpenChange(false);
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not save the subsection')),
  });

  const valid = name.trim().length > 0 && (Boolean(row) || category.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{row ? `Rename ${row.name}` : 'New subsection'}</DialogTitle>
          <DialogDescription>
            {row ? 'Every dish carrying this name moves with it. Past orders keep the old name.' : 'It belongs to one section.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* A subsection cannot change section: that would move dishes between
              sections behind the owner's back. Make a new one instead. */}
          {row ? (
            <p className="text-sm text-muted-foreground">
              Section: <span className="font-medium text-foreground">{row.category}</span>
            </p>
          ) : (
            <CategoryInput
              id="subcategory-section"
              label="Section"
              value={category}
              onChange={setCategory}
              api={restaurantCategoriesApi}
              queryKey="restaurant"
            />
          )}
          <div className="space-y-1.5">
            <Label htmlFor="subcategory-name">Name</Label>
            <Input
              id="subcategory-name"
              value={name}
              maxLength={60}
              placeholder="Mexican"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {row ? 'Save' : 'Add subsection'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
