import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Package, Pill, Shirt, ShoppingCart, Store, UtensilsCrossed, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { ApiError } from '@/api/client';
import { platformApi, type PosProduct } from '@/api/endpoints';

const ICONS: Record<string, LucideIcon> = {
  shirt: Shirt,
  utensils: UtensilsCrossed,
  pill: Pill,
  'shopping-cart': ShoppingCart,
  store: Store,
  package: Package,
};

function ProductIcon({ icon }: { icon: string }) {
  const Icon = ICONS[icon] ?? Store;
  return <Icon className="h-4 w-4 text-muted-foreground" />;
}

/**
 * The platform POS product catalog: which POS types exist, and which are
 * offered. Activation only offers a type; a workspace can be opened only when
 * its POS module also exists, which the server decides.
 */
export function PosProductsTab() {
  const queryClient = useQueryClient();
  const [openCode, setOpenCode] = React.useState<string | null>(null);
  const [deactivating, setDeactivating] = React.useState<PosProduct | null>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['platform', 'pos-products'], queryFn: platformApi.posProducts });

  const setStatus = useMutation({
    mutationFn: ({ code, status }: { code: string; status: PosProduct['status'] }) => platformApi.setPosProductStatus(code, status),
    onSuccess: (product) => {
      toast.success(`${product.name} is now ${product.status === 'active' ? 'offered' : 'hidden from new workspaces'}`);
      setDeactivating(null);
      void queryClient.invalidateQueries({ queryKey: ['platform', 'pos-products'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change the POS type'),
  });

  const columns: Column<PosProduct>[] = [
    {
      key: 'name',
      header: 'POS type',
      mobile: 'title',
      cell: (row) => (
        <div className="flex items-start gap-2">
          <ProductIcon icon={row.icon} />
          <div>
            <p className="font-medium">
              {row.name} {row.isDefault && <Badge variant="secondary">Default</Badge>}
            </p>
            <p className="font-mono text-xs text-muted-foreground">{row.code}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <Badge variant={row.status === 'active' ? 'success' : 'secondary'}>{row.status === 'active' ? 'Active' : 'Inactive'}</Badge>,
    },
    {
      key: 'module',
      header: 'POS module',
      mobile: 'hide',
      cell: (row) =>
        row.moduleAvailable ? <span className="text-sm">Available</span> : <span className="text-sm text-muted-foreground">Not built yet</span>,
    },
    { key: 'workspaces', header: 'Workspaces', mobile: 'meta', cell: (row) => <span className="tabular">{row.workspaceCount}</span> },
    {
      key: 'actions',
      header: '',
      mobile: 'actions',
      cell: (row) =>
        row.status === 'active' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={row.isDefault}
            title={row.isDefault ? 'The default POS type cannot be deactivated' : undefined}
            onClick={(event) => {
              event.stopPropagation();
              setDeactivating(row);
            }}
          >
            Deactivate
          </Button>
        ) : (
          <Button
            size="sm"
            loading={setStatus.isPending && setStatus.variables?.code === row.code}
            onClick={(event) => {
              event.stopPropagation();
              setStatus.mutate({ code: row.code, status: 'active' });
            }}
          >
            Activate
          </Button>
        ),
    },
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        POS types customers can choose when opening a workspace. Deactivating one stops new workspaces of that type; existing
        workspaces keep working.
      </p>
      <DataTable
        columns={columns}
        rows={data ?? []}
        rowKey={(row) => row.code}
        loading={isLoading}
        error={error ? (error instanceof ApiError ? error.message : 'Could not load POS types') : null}
        onRetry={() => void refetch()}
        onRowClick={(row) => setOpenCode(row.code)}
        emptyTitle="No POS types"
      />

      <PosProductDetailDialog code={openCode} onClose={() => setOpenCode(null)} />

      <ConfirmDialog
        open={deactivating !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivating(null);
        }}
        title={`Deactivate ${deactivating?.name ?? ''} POS?`}
        description={`No new ${deactivating?.name ?? ''} workspaces can be created. The ${deactivating?.workspaceCount ?? 0} existing workspace(s) and their sales are not affected.`}
        confirmLabel="Deactivate"
        destructive
        loading={setStatus.isPending}
        onConfirm={() => {
          if (deactivating) setStatus.mutate({ code: deactivating.code, status: 'inactive' });
        }}
      />
    </div>
  );
}

function PosProductDetailDialog({ code, onClose }: { code: string | null; onClose: () => void }) {
  const { data: product } = useQuery({
    queryKey: ['platform', 'pos-products', code],
    queryFn: () => platformApi.posProduct(code!),
    enabled: code !== null,
  });

  return (
    <Dialog open={code !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {product && <ProductIcon icon={product.icon} />}
            {product?.name ?? 'POS type'}
          </DialogTitle>
          <DialogDescription>{product?.description || 'No description.'}</DialogDescription>
        </DialogHeader>
        {product && (
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Detail label="Code" value={<span className="font-mono">{product.code}</span>} />
            <Detail label="Status" value={product.status === 'active' ? 'Active' : 'Inactive'} />
            <Detail label="POS module" value={product.moduleAvailable ? 'Available' : 'Not built yet'} />
            <Detail label="Workspaces" value={String(product.workspaceCount)} />
            <Detail label="Plans for this type" value={String(product.planCount)} />
            <Detail label="Sort order" value={String(product.configuration.sortOrder)} />
            <Detail label="Updated" value={format(new Date(product.updatedAt), 'd MMM yyyy, HH:mm')} />
            <div className="col-span-2">
              <dt className="text-xs text-muted-foreground">Highlights</dt>
              <dd>
                {product.configuration.highlights.length === 0 ? (
                  <span className="text-muted-foreground">None</span>
                ) : (
                  <ul className="list-inside list-disc">
                    {product.configuration.highlights.map((highlight) => (
                      <li key={highlight}>{highlight}</li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          </dl>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
