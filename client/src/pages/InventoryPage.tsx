import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Boxes, PackageX, SlidersHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { QuantityInput } from '@/components/QuantityInput';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { ApiError } from '@/api/client';
import { categoryApi, inventoryApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import type { InventoryRow, LedgerEntry } from '@/types/domain';
import { cn } from '@/lib/utils';

const LEDGER_LABELS: Record<string, string> = {
  INITIAL_STOCK: 'Opening stock',
  PURCHASE: 'Purchase',
  SALE: 'Sale',
  RETURN: 'Return',
  MANUAL_ADJUSTMENT: 'Adjustment',
  SALE_CANCELLED: 'Sale cancelled',
};

export function InventoryPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const queryClient = useQueryClient();

  const [tab, setTab] = React.useState('stock');
  const [page, setPage] = React.useState(1);
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);
  const [filter, setFilter] = React.useState('all');
  const [categoryId, setCategoryId] = React.useState('all');
  const [sortBy, setSortBy] = React.useState('stockAsc');
  const [adjusting, setAdjusting] = React.useState<InventoryRow | null>(null);

  const { data: summary } = useQuery({ queryKey: ['inventory', 'summary'], queryFn: inventoryApi.summary });

  // Reused from the categories module - no new endpoint needed.
  const { data: categories } = useQuery({
    queryKey: ['categories', 'all'],
    queryFn: () => categoryApi.list({ limit: 100 }),
  });

  const stock = useQuery({
    queryKey: ['inventory', 'stock', page, search, filter, categoryId, sortBy],
    queryFn: () =>
      inventoryApi.list({
        page,
        limit: 20,
        search,
        sortBy,
        ...(categoryId !== 'all' ? { categoryId } : {}),
        ...(filter === 'low' ? { lowStockOnly: true } : {}),
        ...(filter === 'out' ? { outOfStockOnly: true } : {}),
      }),
    enabled: tab === 'stock',
  });

  const [ledgerPage, setLedgerPage] = React.useState(1);
  const ledger = useQuery({
    queryKey: ['inventory', 'ledger', ledgerPage],
    queryFn: () => inventoryApi.ledger({ page: ledgerPage, limit: 25 }),
    enabled: tab === 'ledger',
  });

  const stockColumns: Column<InventoryRow>[] = [
    {
      key: 'item',
      header: 'Item',
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.productNameSnapshot}</p>
          <p className="truncate text-xs text-muted-foreground">
            {row.name} · <span className="font-mono">{row.sku}</span>
          </p>
        </div>
      ),
    },
    {
      key: 'stock',
      header: 'On hand',
      cell: (row) => {
        const low = row.lowStockThreshold > 0 && row.stock <= row.lowStockThreshold;
        return (
          <div className="flex items-center gap-2">
            <span className={cn('tabular font-semibold', row.stock === 0 && 'text-destructive')}>{row.stock}</span>
            {row.stock === 0 ? (
              <Badge variant="destructive">Out</Badge>
            ) : low ? (
              <Badge variant="warning">Low</Badge>
            ) : null}
          </div>
        );
      },
    },
    { key: 'threshold', header: 'Low at', cell: (row) => <span className="tabular">{row.lowStockThreshold || '—'}</span> },
    { key: 'cost', header: 'Cost', cell: (row) => <span className="tabular">{formatMoney(row.costPriceMinor, currency)}</span> },
    { key: 'price', header: 'Sell', cell: (row) => <span className="tabular">{formatMoney(row.sellingPriceMinor, currency)}</span> },
    {
      key: 'value',
      header: 'Stock value',
      cell: (row) => <span className="tabular">{formatMoney(row.stock * row.costPriceMinor, currency)}</span>,
    },
    {
      key: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <PermissionGate anyOf={['inventory.adjust']}>
          <Button variant="outline" size="sm" onClick={() => setAdjusting(row)}>
            <SlidersHorizontal />
            Adjust
          </Button>
        </PermissionGate>
      ),
    },
  ];

  const ledgerColumns: Column<LedgerEntry>[] = [
    {
      key: 'when',
      header: 'When',
      cell: (row) => (
        <div className="whitespace-nowrap text-xs">
          <p>{format(new Date(row.createdAt), 'dd MMM yyyy')}</p>
          <p className="text-muted-foreground">{format(new Date(row.createdAt), 'hh:mm a')}</p>
        </div>
      ),
    },
    {
      key: 'item',
      header: 'Item',
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.productNameSnapshot}</p>
          <p className="truncate text-xs text-muted-foreground">
            {row.variantNameSnapshot} · <span className="font-mono">{row.skuSnapshot}</span>
          </p>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      cell: (row) => <Badge variant="secondary">{LEDGER_LABELS[row.type] ?? row.type}</Badge>,
    },
    {
      key: 'change',
      header: 'Change',
      cell: (row) => (
        <span
          className={cn(
            'tabular inline-flex items-center gap-1 font-semibold',
            row.quantityChange > 0 ? 'text-success' : 'text-destructive',
          )}
        >
          {row.quantityChange > 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
          {row.quantityChange > 0 ? '+' : ''}
          {row.quantityChange}
        </span>
      ),
    },
    {
      key: 'balance',
      header: 'Balance',
      cell: (row) => (
        <span className="tabular text-sm text-muted-foreground">
          {row.previousStock} → <span className="font-semibold text-foreground">{row.newStock}</span>
        </span>
      ),
    },
    {
      key: 'ref',
      header: 'Reference',
      cell: (row) => (
        <div className="text-xs">
          {row.referenceNumber && <p className="font-mono">{row.referenceNumber}</p>}
          {row.reason && <p className="text-muted-foreground">{row.reason}</p>}
        </div>
      ),
    },
    { key: 'by', header: 'By', cell: (row) => <span className="text-xs">{row.performedByNameSnapshot || '—'}</span> },
  ];

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Inventory"
        description="Live stock levels and a full audit trail of every movement."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={<Boxes className="h-4 w-4" />} label="Units on hand" value={String(summary?.totalUnits ?? 0)} />
        <StatCard
          label="Stock value (cost)"
          value={formatMoney(summary?.stockValueMinor ?? 0, currency)}
          hint={`Retail ${formatMoney(summary?.retailValueMinor ?? 0, currency)}`}
        />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Low stock"
          value={String(summary?.lowStock ?? 0)}
          tone={summary?.lowStock ? 'warning' : undefined}
        />
        <StatCard
          icon={<PackageX className="h-4 w-4" />}
          label="Out of stock"
          value={String(summary?.outOfStock ?? 0)}
          tone={summary?.outOfStock ? 'destructive' : undefined}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="stock">Stock on hand</TabsTrigger>
          <TabsTrigger value="ledger">Movement ledger</TabsTrigger>
        </TabsList>

        <TabsContent value="stock" className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <SearchInput value={term} onChange={setTerm} placeholder="Search product, variant or SKU…" className="w-full sm:max-w-xs" />
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

            <Select value={filter} onValueChange={(value) => { setFilter(value); setPage(1); }}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All items</SelectItem>
                <SelectItem value="low">Low stock</SelectItem>
                <SelectItem value="out">Out of stock</SelectItem>
              </SelectContent>
            </Select>

            <Select value={sortBy} onValueChange={(value) => { setSortBy(value); setPage(1); }}>
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stockAsc">Stock: low to high</SelectItem>
                <SelectItem value="stockDesc">Stock: high to low</SelectItem>
                <SelectItem value="name">Name (A–Z)</SelectItem>
                <SelectItem value="valueDesc">Price: high to low</SelectItem>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Card>
            <DataTable
              columns={stockColumns}
              rows={stock.data?.items ?? []}
              rowKey={(row) => row._id}
              loading={stock.isLoading}
              meta={stock.data?.meta}
              onPageChange={setPage}
              emptyTitle="No stock records"
              emptyDescription="Add products to start tracking inventory."
            />
          </Card>
        </TabsContent>

        <TabsContent value="ledger">
          <Card>
            <DataTable
              columns={ledgerColumns}
              rows={ledger.data?.items ?? []}
              rowKey={(row) => row._id}
              loading={ledger.isLoading}
              meta={ledger.data?.meta}
              onPageChange={setLedgerPage}
              emptyTitle="No movements yet"
              emptyDescription="Every sale, return and adjustment will appear here."
            />
          </Card>
        </TabsContent>
      </Tabs>

      <AdjustStockDialog
        row={adjusting}
        onClose={() => setAdjusting(null)}
        onDone={() => {
          void queryClient.invalidateQueries({ queryKey: ['inventory'] });
          void queryClient.invalidateQueries({ queryKey: ['pos-search'] });
          void queryClient.invalidateQueries({ queryKey: ['products'] });
        }}
      />
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: 'warning' | 'destructive';
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </div>
        <p
          className={cn(
            'tabular mt-1 text-2xl font-semibold',
            tone === 'warning' && 'text-warning',
            tone === 'destructive' && 'text-destructive',
          )}
        >
          {value}
        </p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function AdjustStockDialog({
  row,
  onClose,
  onDone,
}: {
  row: InventoryRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = React.useState<'delta' | 'set'>('delta');
  const [direction, setDirection] = React.useState<'add' | 'remove'>('add');
  const [amount, setAmount] = React.useState<number | null>(null);
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (row) {
      setMode('delta');
      setDirection('add');
      setAmount(null);
      setReason('');
    }
  }, [row]);

  const adjust = useMutation({
    mutationFn: () =>
      inventoryApi.adjust({
        variantId: row!._id,
        mode,
        // "Remove" is expressed as a negative delta; the server writes the
        // ledger entry and refuses to take stock below zero.
        value: mode === 'delta' && direction === 'remove' ? -(amount ?? 0) : amount ?? 0,
        reason: reason.trim(),
      }),
    onSuccess: (result) => {
      toast.success('Stock adjusted', { description: `${result.previousStock} → ${result.newStock}` });
      onDone();
      onClose();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not adjust stock'),
  });

  const invalid = amount === null || amount <= 0 || reason.trim().length < 2;
  const projected =
    row && amount !== null
      ? mode === 'set'
        ? amount
        : direction === 'add'
          ? row.stock + amount
          : row.stock - amount
      : null;

  return (
    <Dialog open={Boolean(row)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust stock</DialogTitle>
          <DialogDescription>
            {row?.productNameSnapshot} · {row?.name} — currently <strong>{row?.stock}</strong> on hand
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Adjustment type</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={mode === 'delta' && direction === 'add' ? 'default' : 'outline'}
                size="sm"
                onClick={() => { setMode('delta'); setDirection('add'); }}
              >
                Add stock
              </Button>
              <Button
                type="button"
                variant={mode === 'delta' && direction === 'remove' ? 'default' : 'outline'}
                size="sm"
                onClick={() => { setMode('delta'); setDirection('remove'); }}
              >
                Remove stock
              </Button>
              <Button
                type="button"
                variant={mode === 'set' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setMode('set')}
              >
                Set exact
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{mode === 'set' ? 'New quantity' : 'Quantity'}</Label>
            <QuantityInput value={amount} onChange={setAmount} showSteppers={false} ariaLabel="Adjustment quantity" />
            {projected !== null && (
              <p className={cn('text-xs', projected < 0 ? 'text-destructive' : 'text-muted-foreground')}>
                {projected < 0
                  ? 'This would take stock below zero and will be rejected.'
                  : `New level will be ${projected}`}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="adj-reason">Reason</Label>
            <Input
              id="adj-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Stock count correction, damaged goods, new delivery…"
            />
            <p className="text-xs text-muted-foreground">Recorded permanently in the inventory ledger.</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => adjust.mutate()} disabled={invalid} loading={adjust.isPending}>
            Apply adjustment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
