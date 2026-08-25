import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { FolderTree, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { ApiError } from '@/api/client';
import { categoryApi } from '@/api/endpoints';
import type { Category } from '@/types/domain';

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

export function CategoriesPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);
  const [editing, setEditing] = React.useState<Category | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Category | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['categories', page, search],
    queryFn: () => categoryApi.list({ page, limit: 20, search, includeInactive: true }),
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '', isActive: true },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ name: '', description: '', isActive: true });
    setDialogOpen(true);
  };

  const openEdit = (category: Category) => {
    setEditing(category);
    form.reset({ name: category.name, description: category.description, isActive: category.isActive });
    setDialogOpen(true);
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['categories'] });
    void queryClient.invalidateQueries({ queryKey: ['products'] });
  };

  const save = useMutation({
    mutationFn: (values: FormValues) =>
      editing ? categoryApi.update(editing._id, values) : categoryApi.create(values),
    onSuccess: () => {
      toast.success(editing ? 'Category updated' : 'Category created');
      setDialogOpen(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the category'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => categoryApi.remove(id),
    onSuccess: (result) => {
      toast.success('Category removed', {
        description:
          result.detachedProducts > 0
            ? `${result.detachedProducts} product(s) were detached. Historical sales are unaffected.`
            : 'Historical sales are unaffected.',
      });
      setDeleting(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not delete the category'),
  });

  const columns: Column<Category>[] = [
    {
      key: 'name',
      header: 'Category',
      cell: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          {row.description && <p className="text-xs text-muted-foreground">{row.description}</p>}
        </div>
      ),
    },
    {
      key: 'products',
      header: 'Products',
      cell: (row) => <span className="tabular">{row.productCount ?? 0}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) =>
        row.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Inactive</Badge>,
    },
    {
      key: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <PermissionGate anyOf={['categories.edit']}>
            <Button variant="ghost" size="icon-sm" onClick={() => openEdit(row)} aria-label="Edit">
              <Pencil />
            </Button>
          </PermissionGate>
          <PermissionGate anyOf={['categories.delete']}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setDeleting(row)}
              aria-label="Delete"
            >
              <Trash2 />
            </Button>
          </PermissionGate>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Categories"
        description="Group your products. Deleting a category never changes past sales."
        actions={
          <PermissionGate anyOf={['categories.create']}>
            <Button onClick={openCreate}>
              <Plus />
              New category
            </Button>
          </PermissionGate>
        }
      />

      <SearchInput value={term} onChange={setTerm} placeholder="Search categories…" className="max-w-sm" />

      <Card>
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(row) => row._id}
          loading={isLoading}
          error={error ? (error as Error).message : null}
          onRetry={() => void refetch()}
          meta={data?.meta}
          onPageChange={setPage}
          emptyTitle="No categories yet"
          emptyDescription="Categories help you organise the catalogue and read your reports."
          emptyAction={
            <PermissionGate anyOf={['categories.create']}>
              <Button onClick={openCreate}>
                <FolderTree />
                Create your first category
              </Button>
            </PermissionGate>
          }
        />
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit category' : 'New category'}</DialogTitle>
            <DialogDescription>
              {editing ? 'Renaming updates live products; past sales keep their original names.' : 'Give the category a clear, short name.'}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={form.handleSubmit((values) => save.mutate(values))} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="cat-name">Name</Label>
              <Input id="cat-name" autoFocus {...form.register('name')} />
              {form.formState.errors.name && (
                <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cat-desc">Description</Label>
              <Textarea id="cat-desc" rows={2} {...form.register('description')} />
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="cat-active">Active</Label>
                <p className="text-xs text-muted-foreground">Inactive categories stay out of the product form</p>
              </div>
              <Switch
                id="cat-active"
                checked={form.watch('isActive')}
                onCheckedChange={(checked) => form.setValue('isActive', checked)}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={save.isPending}>
                {editing ? 'Save changes' : 'Create category'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete "${deleting?.name}"?`}
        description={
          <span>
            The category is soft-deleted, so <strong>past sales and reports stay exactly as they are</strong>.
            {(deleting?.productCount ?? 0) > 0 && (
              <> {deleting?.productCount} product(s) will be moved to “no category”.</>
            )}
          </span>
        }
        confirmLabel="Delete category"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting._id);
        }}
      />
    </div>
  );
}
