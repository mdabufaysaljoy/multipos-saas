import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { RotateCcw, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { PosReturnDialog, type ReturnableSaleLine } from '@/features/returns/PosReturnDialog';
import { ApiError } from '@/api/client';
import { storeApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import type { PosReturn } from '@/types/domain';
import type { PageMeta } from '@/types/api';

/** A sale, reduced to what choosing one to return against needs. */
export interface ReturnableSaleSummary {
  id: string;
  number: string;
  at: string;
  /** The second line of the row: a customer, a table, a line count. */
  detail: string;
  totalMinor: number;
}

interface PosReturnsScreenProps<TSale> {
  title: string;
  description: string;
  /** What the refund is called here: "return" everywhere but a restaurant. */
  noun: { one: string; New: string };
  listReturns: (params: Record<string, unknown>) => Promise<{ items: PosReturn[]; meta?: PageMeta }>;
  /** Completed sales matching a search, newest first. */
  findSales: (search: string) => Promise<{ items: TSale[] }>;
  summarise: (sale: TSale) => ReturnableSaleSummary;
  linesOf: (sale: TSale) => ReturnableSaleLine[];
  createReturn: (
    saleId: string,
    input: { items: { saleItemId: string; quantity: number; restock: boolean }[]; reason: string; refundMethod: string },
  ) => Promise<unknown>;
  /** Query keys to refresh once something has come back. */
  invalidate: string[];
  /** False for a restaurant: nothing goes back on a shelf, only money moves. */
  restockable?: boolean;
  searchPlaceholder: string;
}

/**
 * Everything that has come back in this branch, and the way to take something
 * back: find the sale, choose the lines, refund on a tender the branch takes.
 *
 * One screen for every POS type. The vertical supplies its own endpoints and
 * says how to read one of its sales; the behaviour - a return always belongs to
 * a sale, only what is left can be chosen - is the same everywhere, because it
 * is the same engine behind it (`docs/RETURNS.md`).
 */
export function PosReturnsScreen<TSale>({
  title,
  description,
  noun,
  listReturns,
  findSales,
  summarise,
  linesOf,
  createReturn,
  invalidate,
  restockable = true,
  searchPlaceholder,
}: PosReturnsScreenProps<TSale>) {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const money = (minor: number) => formatMoney(minor, currency);

  const [page, setPage] = React.useState(1);
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);
  const [finding, setFinding] = React.useState(false);
  const [chosen, setChosen] = React.useState<TSale | null>(null);

  const { data: posConfig } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [...invalidate, 'returns-screen', page, search],
    queryFn: () => listReturns({ page, limit: 20, search }),
  });

  const columns: Column<PosReturn>[] = [
    {
      key: 'number',
      header: noun.New,
      mobile: 'title',
      cell: (row) => (
        <div>
          <p className="font-mono text-sm font-medium">{row.returnNumber}</p>
          <p className="text-xs text-muted-foreground">{format(new Date(row.returnedAt), 'd MMM yyyy, hh:mm a')}</p>
        </div>
      ),
    },
    { key: 'sale', header: 'Original sale', cell: (row) => <span className="font-mono text-sm">{row.saleNumberSnapshot}</span> },
    {
      key: 'items',
      header: 'Items',
      cell: (row) => (
        <div className="max-w-xs">
          <p className="tabular text-sm">{row.items.reduce((sum, item) => sum + item.quantity, 0)} unit(s)</p>
          <p className="truncate text-xs text-muted-foreground">{row.items.map((item) => item.productNameSnapshot).join(', ')}</p>
        </div>
      ),
    },
    { key: 'reason', header: 'Reason', mobile: 'hide', cell: (row) => <span className="text-sm">{row.reason || '—'}</span> },
    { key: 'by', header: 'Taken by', mobile: 'hide', cell: (row) => <span className="text-sm">{row.processedByNameSnapshot}</span> },
    {
      key: 'total',
      header: 'Refund',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <div>
          <p className="tabular font-semibold text-destructive">{money(row.totalMinor)}</p>
          <Badge variant="secondary">{row.refundMethodLabel ?? row.refundMethod}</Badge>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader
        title={title}
        description={description}
        actions={
          <PermissionGate anyOf={['returns.create']}>
            <Button onClick={() => setFinding(true)}>
              <RotateCcw />
              New {noun.one}
            </Button>
          </PermissionGate>
        }
      />

      <SearchInput value={term} onChange={setTerm} placeholder={searchPlaceholder} className="max-w-sm" />

      <Card>
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(row) => row._id}
          loading={isLoading}
          error={error ? (error instanceof ApiError ? error.message : 'Could not load this list') : null}
          onRetry={() => void refetch()}
          meta={data?.meta}
          onPageChange={setPage}
          emptyTitle={`No ${noun.one}s yet`}
          emptyDescription="Find a sale to take something back against it."
          emptyAction={
            <PermissionGate anyOf={['returns.create']}>
              <Button onClick={() => setFinding(true)}>
                <Search />
                Find a sale
              </Button>
            </PermissionGate>
          }
        />
      </Card>

      <FindSaleDialog
        open={finding}
        onOpenChange={setFinding}
        currency={currency}
        findSales={findSales}
        summarise={summarise}
        onPick={(sale) => {
          setFinding(false);
          setChosen(sale);
        }}
      />

      {chosen && (
        <PosReturnDialog
          saleNumber={summarise(chosen).number}
          currency={currency}
          posConfig={posConfig}
          restockable={restockable}
          lines={linesOf(chosen)}
          onSubmit={(input) => createReturn(summarise(chosen).id, input)}
          onClose={() => setChosen(null)}
          invalidate={invalidate}
        />
      )}
    </div>
  );
}

/** Step one: a return always belongs to a sale, so the sale is found first. */
function FindSaleDialog<TSale>({
  open,
  onOpenChange,
  currency,
  findSales,
  summarise,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currency: string;
  findSales: (search: string) => Promise<{ items: TSale[] }>;
  summarise: (sale: TSale) => ReturnableSaleSummary;
  onPick: (sale: TSale) => void;
}) {
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);

  const { data, isLoading } = useQuery({
    queryKey: ['pos-returns', 'sale-lookup', search],
    queryFn: () => findSales(search),
    enabled: open,
  });
  const results = data?.items ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Find the original sale</DialogTitle>
          <DialogDescription>Nothing can be refunded on its own: search by sale number, item or customer.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input autoFocus value={term} onChange={(event) => setTerm(event.target.value)} placeholder="INV-000012, item or customer…" />

          <div className="scrollbar-thin max-h-72 space-y-1 overflow-y-auto">
            {isLoading && <p className="py-6 text-center text-sm text-muted-foreground">Searching…</p>}
            {!isLoading && results.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {term ? 'No sale with anything left to return matches that search.' : 'Start typing to find a sale.'}
              </p>
            )}
            {results.map((sale) => {
              const row = summarise(sale);
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => onPick(sale)}
                  className="flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:border-primary hover:bg-accent"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm font-medium">{row.number}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {format(new Date(row.at), 'd MMM yyyy')} · {row.detail}
                    </p>
                  </div>
                  <p className="tabular shrink-0 text-sm font-semibold">{formatMoney(row.totalMinor, currency)}</p>
                </button>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
