import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Factory, Lock, Pencil, Plus, Power, Sparkles, Trash2 } from 'lucide-react';
import { ApiError } from '@/api/client';
import { supplierApi } from '@/api/endpoints';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { LimitAlert } from '@/components/LimitAlert';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { SupplierDetailDialog } from '@/features/suppliers/SupplierDetailDialog';
import { SupplierFormDialog } from '@/features/suppliers/SupplierFormDialog';
import { SUPPLIER_TYPE_LABELS } from '@/features/suppliers/supplierLabels';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import type { SupplierListItem, SupplierType } from '@/types/domain';

/**
 * Suppliers (Clothing POS, Professional and Enterprise).
 *
 * Workspace-level: every branch of the business sees the same supplier list.
 * The server enforces the plan, the permissions and the supplier ceiling; this
 * page shows where the workspace stands and keeps the forms honest.
 */
export function SuppliersPage() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const entitled = session?.entitlement?.features?.supplierManagement === true;

  const [page, setPage] = React.useState(1);
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);
  const [status, setStatus] = React.useState<'all' | 'active' | 'inactive'>('all');
  const [type, setType] = React.useState<'all' | SupplierType>('all');
  const [sort, setSort] = React.useState<'createdAt' | 'name'>('createdAt');

  const [formOpen, setFormOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [viewingId, setViewingId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<SupplierListItem | null>(null);

  const listKey = ['suppliers', page, search, status, type, sort] as const;
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: listKey,
    queryFn: () =>
      supplierApi.list({
        page,
        limit: 20,
        search,
        status,
        ...(type === 'all' ? {} : { type }),
        sort,
        order: sort === 'name' ? 'asc' : 'desc',
      }),
    enabled: entitled,
    retry: false,
  });

  const { data: summary } = useQuery({ queryKey: ['suppliers', 'summary'], queryFn: supplierApi.summary, enabled: entitled, retry: false });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    void queryClient.invalidateQueries({ queryKey: ['usage'] });
  };

  const toggleStatus = useMutation({
    mutationFn: (row: SupplierListItem) => supplierApi.setStatus(row._id, !row.isActive),
    onSuccess: (supplier) => {
      toast.success(supplier.isActive ? 'Supplier reactivated' : 'Supplier deactivated', {
        description: supplier.isActive ? undefined : 'It stays in the list and in any history.',
      });
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change the supplier'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => supplierApi.remove(id),
    onSuccess: () => {
      toast.success('Supplier removed');
      setDeleting(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not remove the supplier'),
  });

  if (!entitled) {
    return (
      <div className="p-4 lg:p-6">
        <Card className="mx-auto max-w-xl">
          <CardContent className="flex flex-col items-center gap-4 p-6 text-center">
            <div className="relative flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Factory className="h-6 w-6" />
              <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border bg-background">
                <Lock className="h-3 w-3" />
              </span>
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">Supplier management</h2>
              <p className="text-sm text-muted-foreground">
                Keep your sourcing contacts, their people, payment terms and tax details in one place. Available on the Professional and Enterprise plans —
                100 suppliers on Professional, unlimited on Enterprise.
              </p>
            </div>
            <Button asChild>
              <Link to="/subscription">
                <Sparkles />
                View plans
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const columns: Column<SupplierListItem>[] = [
    {
      key: 'name',
      mobile: 'title',
      header: 'Supplier',
      cell: (row) => (
        <button type="button" className="min-w-0 text-left" onClick={() => setViewingId(row._id)}>
          <p className="truncate font-medium hover:underline">{row.name}</p>
          <p className="truncate text-xs text-muted-foreground">{row.code}</p>
        </button>
      ),
    },
    {
      key: 'contact',
      mobile: 'meta',
      header: 'Contact person',
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm">{row.contact?.name || '—'}</p>
          <p className="truncate text-xs text-muted-foreground">{row.contact?.phone || row.phone || ''}</p>
        </div>
      ),
    },
    { key: 'phone', mobile: 'meta', header: 'Phone', cell: (row) => <span className="text-sm">{row.phone || '—'}</span> },
    { key: 'email', mobile: 'meta', header: 'Email', cell: (row) => <span className="text-sm">{row.email || '—'}</span> },
    { key: 'type', header: 'Type', cell: (row) => <span className="text-sm">{SUPPLIER_TYPE_LABELS[row.type] ?? row.type}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <Badge variant={row.isActive ? 'success' : 'secondary'}>{row.isActive ? 'Active' : 'Inactive'}</Badge>,
    },
    {
      key: 'created',
      mobile: 'meta',
      header: 'Added',
      cell: (row) => <span className="text-sm text-muted-foreground">{format(new Date(row.createdAt), 'dd MMM yyyy')}</span>,
    },
    {
      key: 'actions',
      mobile: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <PermissionGate anyOf={['suppliers.edit']}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setEditingId(row._id);
                setFormOpen(true);
              }}
              aria-label="Edit supplier"
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => toggleStatus.mutate(row)}
              aria-label={row.isActive ? 'Deactivate supplier' : 'Reactivate supplier'}
              title={row.isActive ? 'Deactivate' : 'Reactivate'}
            >
              <Power className={cn(row.isActive ? 'text-muted-foreground' : 'text-success')} />
            </Button>
          </PermissionGate>
          <PermissionGate anyOf={['suppliers.delete']}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setDeleting(row)}
              aria-label="Remove supplier"
            >
              <Trash2 />
            </Button>
          </PermissionGate>
        </div>
      ),
    },
  ];

  const countLine = summary
    ? summary.unlimited
      ? `${summary.active.toLocaleString()} active · unlimited on ${summary.planName ?? 'your plan'}`
      : `${summary.active.toLocaleString()} / ${(summary.max ?? 0).toLocaleString()} suppliers`
    : '';

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Suppliers"
        description="Who you buy from. Shared across every branch of this workspace."
        actions={
          <PermissionGate anyOf={['suppliers.create']}>
            <Button
              onClick={() => {
                setEditingId(null);
                setFormOpen(true);
              }}
            >
              <Plus />
              Add supplier
            </Button>
          </PermissionGate>
        }
      />

      {summary && (
        <p className="text-sm text-muted-foreground">
          {countLine}
          {summary.inactive > 0 && ` · ${summary.inactive.toLocaleString()} inactive`}
        </p>
      )}

      {/* After a downgrade a workspace can hold more suppliers than the plan allows. */}
      {summary?.overLimit && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
          You have {summary.active.toLocaleString()} suppliers and {summary.planName ?? 'your plan'} allows {(summary.max ?? 0).toLocaleString()}. Nothing has
          been deleted — you can still view and edit them, but you cannot add more until you deactivate some or upgrade.
        </div>
      )}

      <LimitAlert resource="suppliers" />

      <div className="flex flex-wrap gap-2">
        <SearchInput value={term} onChange={setTerm} placeholder="Search name, code, contact, phone or email…" className="w-full sm:max-w-xs" />

        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value as typeof status);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[9.5rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={type}
          onValueChange={(value) => {
            setType(value as typeof type);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[10.5rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {Object.entries(SUPPLIER_TYPE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={sort}
          onValueChange={(value) => {
            setSort(value as typeof sort);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[10rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="createdAt">Newest first</SelectItem>
            <SelectItem value="name">Name A–Z</SelectItem>
          </SelectContent>
        </Select>
      </div>

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
          emptyTitle={search || status !== 'all' || type !== 'all' ? 'No matching suppliers' : 'No suppliers yet'}
          emptyDescription={
            search || status !== 'all' || type !== 'all'
              ? 'Try a different search or filter.'
              : 'Save your supplier information here to keep your sourcing contacts organised.'
          }
          emptyAction={
            <PermissionGate anyOf={['suppliers.create']}>
              <Button
                onClick={() => {
                  setEditingId(null);
                  setFormOpen(true);
                }}
              >
                <Plus />
                Add supplier
              </Button>
            </PermissionGate>
          }
        />
      </Card>

      <SupplierFormDialog
        open={formOpen}
        supplierId={editingId}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditingId(null);
        }}
        onSaved={invalidate}
      />

      <SupplierDetailDialog
        supplierId={viewingId}
        onOpenChange={(open) => !open && setViewingId(null)}
        onEdit={(id) => {
          setViewingId(null);
          setEditingId(id);
          setFormOpen(true);
        }}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Remove "${deleting?.name}"?`}
        description="The record is soft-deleted and its code is freed. Deactivate instead if you may buy from them again."
        confirmLabel="Remove supplier"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting._id);
        }}
      />
    </div>
  );
}
