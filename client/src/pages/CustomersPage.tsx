import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Pencil, Plus, Trash2, UsersRound } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { LimitAlert } from '@/components/LimitAlert';
import { PermissionGate } from '@/components/PermissionGate';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { ApiError } from '@/api/client';
import { customerApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import type { Customer } from '@/types/domain';

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(160),
  phone: z.string().trim().min(3, 'Phone number is required').max(32),
  email: z.string().email('Enter a valid email').or(z.literal('')).optional(),
  address: z.string().trim().max(400).optional(),
  notes: z.string().trim().max(1000).optional(),
});
type FormValues = z.infer<typeof schema>;

export function CustomersPage() {
  const queryClient = useQueryClient();
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';

  const [page, setPage] = React.useState(1);
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);
  const [editing, setEditing] = React.useState<Customer | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Customer | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['customers', page, search],
    queryFn: () => customerApi.list({ page, limit: 20, search }),
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', phone: '', email: '', address: '', notes: '' },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ name: '', phone: '', email: '', address: '', notes: '' });
    setDialogOpen(true);
  };

  const openEdit = (customer: Customer) => {
    setEditing(customer);
    form.reset({
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      address: customer.address,
      notes: customer.notes,
    });
    setDialogOpen(true);
  };

  const save = useMutation({
    mutationFn: (values: FormValues) =>
      editing ? customerApi.update(editing._id, values) : customerApi.create(values),
    onSuccess: () => {
      toast.success(editing ? 'Customer updated' : 'Customer added');
      setDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the customer'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => customerApi.remove(id),
    onSuccess: () => {
      toast.success('Customer removed', { description: 'Past sales still show their details.' });
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not delete the customer'),
  });

  const columns: Column<Customer>[] = [
    {
      key: 'name', mobile: 'title',
      header: 'Customer',
      cell: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-muted-foreground">{row.phone}</p>
        </div>
      ),
    },
    { key: 'email', mobile: 'meta', header: 'Email', cell: (row) => <span className="text-sm">{row.email || '—'}</span> },
    { key: 'orders', header: 'Orders', cell: (row) => <span className="tabular">{row.orderCount}</span> },
    {
      key: 'spent',
      header: 'Lifetime value',
      cell: (row) => <span className="tabular font-medium">{formatMoney(row.totalSpentMinor, currency)}</span>,
    },
    {
      key: 'last',
      header: 'Last purchase',
      cell: (row) => (
        <span className="text-sm text-muted-foreground">
          {row.lastPurchaseAt ? format(new Date(row.lastPurchaseAt), 'dd MMM yyyy') : '—'}
        </span>
      ),
    },
    {
      key: 'actions', mobile: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <PermissionGate anyOf={['customers.edit']}>
            <Button variant="ghost" size="icon-sm" onClick={() => openEdit(row)} aria-label="Edit customer">
              <Pencil />
            </Button>
          </PermissionGate>
          <PermissionGate anyOf={['customers.delete']}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setDeleting(row)}
              aria-label="Delete customer"
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
        title="Customers"
        description="Optional at checkout — a walk-in sale never needs a customer record."
        actions={
          <PermissionGate anyOf={['customers.create']}>
            <Button onClick={openCreate}>
              <Plus />
              New customer
            </Button>
          </PermissionGate>
        }
      />
      <LimitAlert resource="customers" />

      <SearchInput value={term} onChange={setTerm} placeholder="Search name, phone or email…" className="max-w-sm" />

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
          emptyTitle="No customers yet"
          emptyDescription="Customers can also be added during checkout."
          emptyAction={
            <PermissionGate anyOf={['customers.create']}>
              <Button onClick={openCreate}>
                <UsersRound />
                Add your first customer
              </Button>
            </PermissionGate>
          }
        />
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit customer' : 'New customer'}</DialogTitle>
            <DialogDescription>Phone number identifies the customer and must be unique.</DialogDescription>
          </DialogHeader>

          <form onSubmit={form.handleSubmit((values) => save.mutate(values))} className="space-y-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="c-name">Name</Label>
                <Input id="c-name" autoFocus {...form.register('name')} />
                {form.formState.errors.name && (
                  <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-phone">Phone</Label>
                <Input id="c-phone" {...form.register('phone')} />
                {form.formState.errors.phone && (
                  <p className="text-xs text-destructive">{form.formState.errors.phone.message}</p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="c-email">Email (optional)</Label>
              <Input id="c-email" type="email" {...form.register('email')} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="c-address">Address (optional)</Label>
              <Textarea id="c-address" rows={2} {...form.register('address')} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="c-notes">Notes (optional)</Label>
              <Textarea id="c-notes" rows={2} placeholder="Prefers size L, wholesale enquiries…" {...form.register('notes')} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={save.isPending}>
                {editing ? 'Save changes' : 'Add customer'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete "${deleting?.name}"?`}
        description="The record is soft-deleted. Past sales keep the customer details they were made with."
        confirmLabel="Delete customer"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting._id);
        }}
      />
    </div>
  );
}
