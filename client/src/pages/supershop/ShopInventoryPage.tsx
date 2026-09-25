import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { AlertTriangle, Boxes, PackagePlus, PackageX, SlidersHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { AdjustDialog, MOVEMENT_LABELS, ReceiveDialog, errorMessage } from '@/features/supershop/stockDialogs';
import { supershopApi } from '@/api/supershop';
import { formatMoney } from '@/lib/money';
import { formatQuantity, lineAmount } from '@/lib/supershop';
import { useAuth } from '@/hooks/useAuth';
import type { PosLedgerRow } from '@/types/domain';
import type { ShopProduct } from '@/types/supershop';

const LEDGER_TYPES = ['receive', 'sale', 'void', 'adjust', 'write_off'] as const;

/** A ledger row counts in grams for weighed goods, exactly as the movement was written. */
const ledgerQuantity = (row: PosLedgerRow, quantity: number) =>
  formatQuantity(quantity, row.itemDetail === 'by weight' ? 'weight' : 'each');

/** What this branch holds: stock on the shelf, what it is worth, and every movement. */
export function ShopInventoryPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const money = (minor: number) => formatMoney(minor, currency);
  const queryClient = useQueryClient();

  const [tab, setTab] = React.useState('stock');
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term);
  const [lowOnly, setLowOnly] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [receiving, setReceiving] = React.useState<ShopProduct | null>(null);
  const [adjusting, setAdjusting] = React.useState<ShopProduct | null>(null);

  const [type, setType] = React.useState('all');
  const [ledgerPage, setLedgerPage] = React.useState(1);

  const summary = useQuery({ queryKey: ['supershop', 'inventory-summary'], queryFn: supershopApi.inventorySummary });

  const stock = useQuery({
    queryKey: ['supershop', 'inventory', 'stock', search, lowOnly, page],
    queryFn: () => supershopApi.products({ page, limit: 20, search, ...(lowOnly ? { lowStockOnly: 'true' } : {}) }),
    enabled: tab === 'stock',
  });

  const ledger = useQuery({
    queryKey: ['supershop', 'inventory', 'ledger', type, ledgerPage],
    queryFn: () => supershopApi.stockLedger({ page: ledgerPage, limit: 25, ...(type !== 'all' ? { type } : {}) }),
    enabled: tab === 'ledger',
  });

  /** Stock moved: the cards, this list and the catalogue all have to be re-read. */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['supershop'] });
  };

  const stockColumns: Column<ShopProduct>[] = [
    {
      key: 'product',
      header: 'Product',
      mobile: 'title',
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {row.brand ? `${row.brand} · ` : ''}
            {row.category}
            {row.barcode ? ` · ${row.barcode}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'onHand',
      header: 'On hand',
      cell: (row) => {
        const onHand = row.stock?.quantityOnHand ?? 0;
        const low = row.reorderLevel > 0 && onHand > 0 && onHand <= row.reorderLevel;
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={onHand <= 0 ? 'tabular font-semibold text-destructive' : 'tabular font-medium'}>
              {formatQuantity(onHand, row.unitType)}
            </span>
            {onHand <= 0 ? <Badge variant="destructive">Out</Badge> : low ? <Badge variant="warning">Low</Badge> : null}
          </div>
        );
      },
    },
    {
      key: 'reorder',
      header: 'Reorder at',
      mobile: 'hide',
      cell: (row) => <span className="tabular text-muted-foreground">{row.reorderLevel > 0 ? formatQuantity(row.reorderLevel, row.unitType) : '—'}</span>,
    },
    {
      key: 'cost',
      header: 'Average cost',
      cell: (row) => (
        <span className="tabular">
          {money(row.stock?.costPriceMinor ?? 0)}
          {row.unitType === 'weight' ? '/kg' : ''}
        </span>
      ),
    },
    {
      key: 'value',
      header: 'Stock value',
      cell: (row) => (
        <span className="tabular font-medium">{money(lineAmount(row.stock?.costPriceMinor ?? 0, Math.max(0, row.stock?.quantityOnHand ?? 0), row.unitType))}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      mobile: 'actions',
      className: 'text-right',
      cell: (row) => (
        <PermissionGate anyOf={['inventory.adjust']}>
          <div className="flex justify-end gap-1">
            <Button variant="ghost" size="icon-sm" onClick={() => setReceiving(row)} aria-label={`Receive stock of ${row.name}`}>
              <PackagePlus />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setAdjusting(row)} aria-label={`Adjust stock of ${row.name}`}>
              <SlidersHorizontal />
            </Button>
          </div>
        </PermissionGate>
      ),
    },
  ];

  const ledgerColumns: Column<PosLedgerRow>[] = [
    {
      key: 'item',
      header: 'Product',
      mobile: 'title',
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.itemLabel}</p>
          <p className="truncate text-xs text-muted-foreground">
            {format(new Date(row.at), 'd MMM yyyy, HH:mm')} · {row.by}
          </p>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'What happened',
      cell: (row) => (
        <div className="min-w-0">
          <p>{MOVEMENT_LABELS[row.type as keyof typeof MOVEMENT_LABELS] ?? row.type}</p>
          {(row.referenceNumber || row.reason) && (
            <p className="truncate text-xs text-muted-foreground">
              {row.referenceNumber}
              {row.referenceNumber && row.reason ? ' · ' : ''}
              {row.reason}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'change',
      header: 'Change',
      className: 'text-right',
      cell: (row) => (
        <span className={row.quantityChange < 0 ? 'tabular text-destructive' : 'tabular text-success'}>
          {row.quantityChange > 0 ? '+' : '-'}
          {ledgerQuantity(row, Math.abs(row.quantityChange))}
        </span>
      ),
    },
    {
      key: 'balance',
      header: 'Left',
      className: 'text-right',
      mobile: 'hide',
      cell: (row) => <span className="tabular text-muted-foreground">{ledgerQuantity(row, row.balanceAfter)}</span>,
    },
  ];

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader title="Inventory" description="What is on the shelf in this branch, what it is worth, and every stock movement." />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <SummaryCard icon={<Boxes className="h-4 w-4" />} label="Stock value" value={money(summary.data?.stockValueMinor ?? 0)} hint={`${summary.data?.productCount ?? 0} product(s) · ${money(summary.data?.retailValueMinor ?? 0)} at shelf price`} />
        <SummaryCard icon={<AlertTriangle className="h-4 w-4" />} label="Low on stock" value={String(summary.data?.lowStock ?? 0)} hint="At or below the reorder level" tone={(summary.data?.lowStock ?? 0) > 0 ? 'warning' : undefined} />
        <SummaryCard icon={<PackageX className="h-4 w-4" />} label="Out of stock" value={String(summary.data?.outOfStock ?? 0)} hint="Nothing left on the shelf" tone={(summary.data?.outOfStock ?? 0) > 0 ? 'danger' : undefined} />
        <SummaryCard icon={<PackagePlus className="h-4 w-4" />} label="Products" value={String(summary.data?.productCount ?? 0)} hint="In this workspace's catalogue" />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="stock">Stock</TabsTrigger>
          <TabsTrigger value="ledger">Stock ledger</TabsTrigger>
        </TabsList>

        <TabsContent value="stock">
          <Card>
            <div className="flex flex-wrap items-center gap-3 border-b p-3">
              <SearchInput
                value={term}
                onChange={(value) => {
                  setTerm(value);
                  setPage(1);
                }}
                placeholder="Name, brand or barcode…"
                className="w-full sm:max-w-xs"
              />
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={lowOnly}
                  onCheckedChange={(value) => {
                    setLowOnly(value);
                    setPage(1);
                  }}
                />
                Low stock only
              </label>
            </div>
            <DataTable
              columns={stockColumns}
              rows={stock.data?.items ?? []}
              rowKey={(row) => row._id}
              loading={stock.isLoading}
              error={stock.error ? errorMessage(stock.error, 'Could not load the stock') : null}
              onRetry={() => void stock.refetch()}
              meta={stock.data?.meta}
              onPageChange={setPage}
              emptyTitle={lowOnly ? 'Nothing is low on stock' : 'No products yet'}
              emptyDescription={lowOnly ? undefined : 'Add what you sell on Products & stock, then receive stock here.'}
            />
          </Card>
        </TabsContent>

        <TabsContent value="ledger">
          <Card>
            <div className="flex flex-wrap items-center gap-3 border-b p-3">
              <Select
                value={type}
                onValueChange={(value) => {
                  setType(value);
                  setLedgerPage(1);
                }}
              >
                <SelectTrigger className="w-52" aria-label="Movement type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Every movement</SelectItem>
                  {LEDGER_TYPES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {MOVEMENT_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Every change is recorded with who made it; nothing here can be edited.</p>
            </div>
            <DataTable
              columns={ledgerColumns}
              rows={ledger.data?.items ?? []}
              rowKey={(row) => row.id}
              loading={ledger.isLoading}
              error={ledger.error ? errorMessage(ledger.error, 'Could not load the ledger') : null}
              onRetry={() => void ledger.refetch()}
              meta={ledger.data?.meta}
              onPageChange={setLedgerPage}
              emptyTitle="No stock movements yet"
              emptyDescription="Receiving, selling, counting and writing off all show up here."
            />
          </Card>
        </TabsContent>
      </Tabs>

      {receiving && (
        <ReceiveDialog
          key={receiving._id}
          product={receiving}
          currency={currency}
          onClose={() => setReceiving(null)}
          onSaved={() => {
            setReceiving(null);
            refresh();
          }}
        />
      )}
      {adjusting && (
        <AdjustDialog
          key={adjusting._id}
          product={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            setAdjusting(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function SummaryCard({ icon, label, value, hint, tone }: { icon: React.ReactNode; label: string; value: string; hint: string; tone?: 'warning' | 'danger' }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </p>
        <p className={tone === 'danger' ? 'text-xl font-semibold text-destructive' : tone === 'warning' ? 'text-xl font-semibold text-warning' : 'text-xl font-semibold'}>{value}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
