import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { RotateCcw, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { returnApi, saleApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import type { ReturnDoc } from '@/types/domain';

export function ReturnsPage() {
  const navigate = useNavigate();
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';

  const [page, setPage] = React.useState(1);
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);
  const [findOpen, setFindOpen] = React.useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['returns', page, search],
    queryFn: () => returnApi.list({ page, limit: 20, search }),
  });

  const columns: Column<ReturnDoc>[] = [
    {
      key: 'number',
      header: 'Return',
      cell: (row) => (
        <div>
          <p className="font-mono text-sm font-medium">{row.returnNumber}</p>
          <p className="text-xs text-muted-foreground">{format(new Date(row.returnedAt), 'dd MMM yyyy, hh:mm a')}</p>
        </div>
      ),
    },
    {
      key: 'sale',
      header: 'Original sale',
      cell: (row) => <span className="font-mono text-sm">{row.saleNumberSnapshot}</span>,
    },
    {
      key: 'customer',
      header: 'Customer',
      cell: (row) =>
        row.customerSnapshot?.name ? (
          <div>
            <p className="text-sm">{row.customerSnapshot.name}</p>
            <p className="text-xs text-muted-foreground">{row.customerSnapshot.phone}</p>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">Walk-in</span>
        ),
    },
    {
      key: 'items',
      header: 'Items',
      cell: (row) => (
        <div className="max-w-xs">
          <p className="tabular text-sm">{row.items.reduce((sum, item) => sum + item.quantity, 0)} unit(s)</p>
          <p className="truncate text-xs text-muted-foreground">
            {row.items.map((item) => item.productNameSnapshot).join(', ')}
          </p>
        </div>
      ),
    },
    { key: 'reason', header: 'Reason', cell: (row) => <span className="text-sm">{row.reason || '—'}</span> },
    { key: 'by', header: 'Processed by', cell: (row) => <span className="text-sm">{row.processedByNameSnapshot}</span> },
    {
      key: 'total',
      header: 'Refund',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <div>
          <p className="tabular font-semibold text-destructive">{formatMoney(row.totalMinor, currency)}</p>
          <Badge variant="secondary">{row.refundMethod}</Badge>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Returns"
        description="Every return is tied to an original sale. Standalone returns are not possible."
        actions={
          <PermissionGate anyOf={['returns.create']}>
            <Button onClick={() => setFindOpen(true)}>
              <RotateCcw />
              New return
            </Button>
          </PermissionGate>
        }
      />

      <SearchInput
        value={term}
        onChange={setTerm}
        placeholder="Return number, invoice number or customer…"
        className="max-w-sm"
      />

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
          emptyTitle="No returns yet"
          emptyDescription="Find a sale to start a return against it."
          emptyAction={
            <PermissionGate anyOf={['returns.create']}>
              <Button onClick={() => setFindOpen(true)}>
                <Search />
                Find a sale
              </Button>
            </PermissionGate>
          }
        />
      </Card>

      <FindSaleDialog
        open={findOpen}
        onOpenChange={setFindOpen}
        onPick={(saleId) => {
          setFindOpen(false);
          navigate(`/returns/new/${saleId}`);
        }}
      />
    </div>
  );
}

/** Step one of a return: locate the sale it belongs to. */
function FindSaleDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (saleId: string) => void;
}) {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);

  const { data, isLoading } = useQuery({
    queryKey: ['sales', 'return-lookup', search],
    queryFn: () => saleApi.list({ search, limit: 8, status: 'completed' }),
    enabled: open,
  });

  const results = (data?.items ?? []).filter((sale) => !sale.fullyReturned);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Find the original sale</DialogTitle>
          <DialogDescription>
            A return must always be made against an existing sale. Search by invoice number, customer name or phone.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            autoFocus
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="INV-000012, customer name or phone…"
          />

          <div className="scrollbar-thin max-h-72 space-y-1 overflow-y-auto">
            {isLoading && <p className="py-6 text-center text-sm text-muted-foreground">Searching…</p>}
            {!isLoading && results.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {term ? 'No returnable sale matches that search.' : 'Start typing to find a sale.'}
              </p>
            )}
            {results.map((sale) => (
              <button
                key={sale._id}
                type="button"
                onClick={() => onPick(sale._id)}
                className="flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:border-primary hover:bg-accent"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm font-medium">{sale.saleNumber}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {format(new Date(sale.soldAt), 'dd MMM yyyy')} ·{' '}
                    {sale.customerSnapshot?.name ?? 'Walk-in'} · {sale.items.length} line
                    {sale.items.length === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="tabular text-sm font-semibold">{formatMoney(sale.totalMinor, currency)}</p>
                  {sale.returnedTotalMinor > 0 && (
                    <p className="text-xs text-destructive">part returned</p>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { FindSaleDialog };
