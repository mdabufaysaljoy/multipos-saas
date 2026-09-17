import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ImageOff, Package, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { LimitAlert } from '@/components/LimitAlert';
import { PermissionGate } from '@/components/PermissionGate';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { ProductFormDialog } from '@/features/products/ProductFormDialog';
import { ApiError } from '@/api/client';
import { categoryApi, productApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import type { Product } from '@/types/domain';

export function ProductsPage() {
  const queryClient = useQueryClient();
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';

  const [page, setPage] = React.useState(1);
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);
  const [categoryId, setCategoryId] = React.useState('all');
  const [stockFilter, setStockFilter] = React.useState('all');
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<Product | null>(null);

  const { data: categories } = useQuery({
    queryKey: ['categories', 'all'],
    queryFn: () => categoryApi.list({ limit: 100 }),
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['products', page, search, categoryId, stockFilter],
    queryFn: () =>
      productApi.list({
        page,
        limit: 20,
        search,
        includeInactive: true,
        ...(categoryId !== 'all' ? { categoryId } : {}),
        ...(stockFilter === 'low' ? { lowStockOnly: true } : {}),
        ...(stockFilter === 'out' ? { outOfStockOnly: true } : {}),
      }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => productApi.remove(id),
    onSuccess: (result) => {
      toast.success('Product removed', {
        description:
          result.historicalSalesPreserved > 0
            ? `${result.historicalSalesPreserved} past sale(s) still show this product exactly as it was sold.`
            : 'Historical records are unaffected.',
      });
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['pos-search'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not delete the product'),
  });

  const columns: Column<Product>[] = [
    {
      key: 'product', mobile: 'title',
      header: 'Product',
      cell: (row) => {
        const image = row.images?.find((i) => i.isPrimary) ?? row.images?.[0];
        return (
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
              {image ? (
                <img src={image.url} alt="" className="h-full w-full object-cover" />
              ) : (
                <ImageOff className="h-4 w-4 text-muted-foreground/50" />
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium">{row.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                <span className="font-mono">{row.sku}</span>
                {row.brand && ` · ${row.brand}`}
              </p>
            </div>
          </div>
        );
      },
    },
    {
      key: 'category',
      header: 'Category',
      cell: (row) => <span className="text-sm">{row.categoryNameSnapshot || '—'}</span>,
    },
    {
      key: 'variants',
      header: 'Variants',
      cell: (row) => <span className="tabular">{row.variantCount ?? 0}</span>,
    },
    {
      key: 'price',
      header: 'Price',
      cell: (row) => (
        <span className="tabular text-sm">
          {row.minPriceMinor === row.maxPriceMinor
            ? formatMoney(row.minPriceMinor ?? 0, currency)
            : `${formatMoney(row.minPriceMinor ?? 0, currency)} – ${formatMoney(row.maxPriceMinor ?? 0, currency)}`}
        </span>
      ),
    },
    {
      key: 'stock',
      header: 'Stock',
      cell: (row) => {
        const stock = row.totalStock ?? 0;
        if (stock === 0) return <Badge variant="destructive">Out of stock</Badge>;
        if (row.hasLowStock) return <Badge variant="warning">{stock} — low</Badge>;
        return <span className="tabular">{stock}</span>;
      },
    },
    {
      key: 'status', mobile: 'hide',
      header: 'Status',
      cell: (row) =>
        row.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Inactive</Badge>,
    },
    {
      key: 'actions', mobile: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <PermissionGate anyOf={['products.edit']}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setEditingId(row._id);
                setFormOpen(true);
              }}
              aria-label="Edit product"
            >
              <Pencil />
            </Button>
          </PermissionGate>
          <PermissionGate anyOf={['products.delete']}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setDeleting(row)}
              aria-label="Delete product"
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
        title="Products"
        description="Your clothing catalogue. Each colour and size combination is its own sellable variant."
        actions={
          <PermissionGate anyOf={['products.create']}>
            <Button
              onClick={() => {
                setEditingId(null);
                setFormOpen(true);
              }}
            >
              <Plus />
              New product
            </Button>
          </PermissionGate>
        }
      />
      <LimitAlert resource="products" />

      <div className="flex flex-wrap gap-2">
        <SearchInput value={term} onChange={setTerm} placeholder="Search name, SKU or brand…" className="w-full sm:max-w-xs" />

        <Select value={categoryId} onValueChange={(value) => { setCategoryId(value); setPage(1); }}>
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {(categories?.items ?? []).map((category) => (
              <SelectItem key={category._id} value={category._id}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={stockFilter} onValueChange={(value) => { setStockFilter(value); setPage(1); }}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All stock levels</SelectItem>
            <SelectItem value="low">Low stock only</SelectItem>
            <SelectItem value="out">Out of stock only</SelectItem>
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
          emptyTitle="No products yet"
          emptyDescription="Add your first garment, then define its colours and sizes."
          emptyAction={
            <PermissionGate anyOf={['products.create']}>
              <Button
                onClick={() => {
                  setEditingId(null);
                  setFormOpen(true);
                }}
              >
                <Package />
                Add your first product
              </Button>
            </PermissionGate>
          }
        />
      </Card>

      <ProductFormDialog
        open={formOpen}
        productId={editingId}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditingId(null);
        }}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete "${deleting?.name}"?`}
        description={
          <span>
            The product and its variants are soft-deleted and removed from the POS.{' '}
            <strong>Past sales, receipts and reports keep the exact name, price and quantity they were sold at.</strong>
          </span>
        }
        confirmLabel="Delete product"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting._id);
        }}
      />
    </div>
  );
}
