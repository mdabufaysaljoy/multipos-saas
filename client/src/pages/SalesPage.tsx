import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { Eye, Printer, Receipt, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { ReceiptDialog } from '@/features/receipt/ReceiptDialog';
import { SaleDetailDialog } from '@/features/sales/SaleDetailDialog';
import { saleApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import type { Sale } from '@/types/domain';

export function SalesPage() {
  const navigate = useNavigate();
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';

  const [page, setPage] = React.useState(1);
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);
  const [status, setStatus] = React.useState('all');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [receiptId, setReceiptId] = React.useState<string | null>(null);
  const [detailId, setDetailId] = React.useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['sales', page, search, status, from, to],
    queryFn: () =>
      saleApi.list({
        page,
        limit: 20,
        search,
        ...(status !== 'all' ? { status } : {}),
        ...(from ? { from: new Date(from).toISOString() } : {}),
        ...(to ? { to: new Date(`${to}T23:59:59`).toISOString() } : {}),
      }),
  });

  const columns: Column<Sale>[] = [
    {
      key: 'invoice',
      header: 'Invoice',
      cell: (row) => (
        <div>
          <p className="font-mono text-sm font-medium">{row.saleNumber}</p>
          <p className="text-xs text-muted-foreground">{format(new Date(row.soldAt), 'dd MMM yyyy, hh:mm a')}</p>
        </div>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      cell: (row) =>
        row.customerSnapshot ? (
          <div>
            <p className="text-sm">{row.customerSnapshot.name}</p>
            <p className="text-xs text-muted-foreground">{row.customerSnapshot.phone}</p>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">Walk-in</span>
        ),
    },
    { key: 'cashier', header: 'Cashier', cell: (row) => <span className="text-sm">{row.cashierNameSnapshot}</span> },
    {
      key: 'items',
      header: 'Items',
      cell: (row) => <span className="tabular">{row.items.reduce((sum, item) => sum + item.quantity, 0)}</span>,
    },
    {
      key: 'payment',
      header: 'Payment',
      cell: (row) => <Badge variant="secondary">{row.paymentMethod}</Badge>,
    },
    {
      key: 'total',
      header: 'Total',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <div>
          <p className="tabular font-semibold">{formatMoney(row.totalMinor, currency)}</p>
          {row.returnedTotalMinor > 0 && (
            <p className="tabular text-xs text-destructive">-{formatMoney(row.returnedTotalMinor, currency)} returned</p>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) =>
        row.status === 'cancelled' ? (
          <Badge variant="destructive">Cancelled</Badge>
        ) : row.fullyReturned ? (
          <Badge variant="warning">Fully returned</Badge>
        ) : row.returnedTotalMinor > 0 ? (
          <Badge variant="warning">Part returned</Badge>
        ) : (
          <Badge variant="success">Completed</Badge>
        ),
    },
    {
      key: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => setDetailId(row._id)} aria-label="View sale">
            <Eye />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setReceiptId(row._id)} aria-label="Print receipt">
            <Printer />
          </Button>
          {row.status === 'completed' && !row.fullyReturned && (
            <PermissionGate anyOf={['returns.create']}>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => navigate(`/returns/new/${row._id}`)}
                aria-label="Create return"
              >
                <RotateCcw />
              </Button>
            </PermissionGate>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Sales"
        description="Every completed sale is stored permanently with the prices it was actually sold at."
      />

      <div className="flex flex-wrap items-end gap-2">
        <SearchInput
          value={term}
          onChange={setTerm}
          placeholder="Invoice number, customer name or phone…"
          className="w-full sm:max-w-xs"
        />

        <div className="space-y-1">
          <Label className="text-xs">From</Label>
          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">To</Label>
          <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="w-40" />
        </div>

        <Select value={status} onValueChange={(value) => { setStatus(value); setPage(1); }}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sales</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>

        {(from || to || status !== 'all' || term) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setFrom(''); setTo(''); setStatus('all'); setTerm(''); setPage(1); }}
          >
            Clear filters
          </Button>
        )}
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
          onRowClick={(row) => setDetailId(row._id)}
          emptyTitle="No sales found"
          emptyDescription="Completed sales will appear here."
          emptyAction={
            <PermissionGate anyOf={['sales.create']}>
              <Button onClick={() => navigate('/pos')}>
                <Receipt />
                Open the POS
              </Button>
            </PermissionGate>
          }
        />
      </Card>

      <ReceiptDialog saleId={receiptId} onClose={() => setReceiptId(null)} />
      <SaleDetailDialog
        saleId={detailId}
        onClose={() => setDetailId(null)}
        onPrint={(id) => {
          setDetailId(null);
          setReceiptId(id);
        }}
      />
    </div>
  );
}
