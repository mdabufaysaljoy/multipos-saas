import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Printer, Repeat2, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { ShopReceiptDialog } from '@/features/supershop/ShopReceiptDialog';
import { PosReturnDialog } from '@/features/returns/PosReturnDialog';
import { ShopExchangeDialog } from '@/features/supershop/ShopExchangeDialog';
import { storeApi } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { supershopApi } from '@/api/supershop';
import { formatMoney } from '@/lib/money';
import { formatQuantity } from '@/lib/supershop';
import { useAuth } from '@/hooks/useAuth';
import type { ShopSale } from '@/types/supershop';

/** Supershop sales in this branch. Voiding a sale returns its items to stock. */
export function ShopSalesPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term);
  const [status, setStatus] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const [open, setOpen] = React.useState<ShopSale | null>(null);
  const [receiptFor, setReceiptFor] = React.useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['supershop', 'sales', search, status, page],
    queryFn: () => supershopApi.sales({ page, limit: 25, ...(search ? { search } : {}), ...(status !== 'all' ? { status } : {}) }),
  });

  const columns: Column<ShopSale>[] = [
    {
      key: 'number',
      header: 'Sale',
      mobile: 'title',
      cell: (row) => (
        <div>
          <p className="font-mono font-medium">{row.saleNumber}</p>
          <p className="text-xs text-muted-foreground">{format(new Date(row.soldAt), 'd MMM yyyy, HH:mm')}</p>
        </div>
      ),
    },
    { key: 'items', header: 'Lines', mobile: 'hide', cell: (row) => <span className="tabular">{row.items.length}</span> },
    { key: 'cashier', header: 'Cashier', mobile: 'hide', cell: (row) => row.cashierNameSnapshot },
    { key: 'status', header: '', mobile: 'meta', cell: (row) => row.status === 'voided' && <Badge variant="destructive">Voided</Badge> },
    {
      key: 'total',
      header: 'Total',
      className: 'text-right',
      headerClassName: 'text-right',
      cell: (row) => (
        <div>
          <p className="tabular font-medium">{formatMoney(row.totalMinor, currency)}</p>
          <p className="text-xs text-muted-foreground">VAT {formatMoney(row.vatMinor, currency)}</p>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader title="Sales" description="Every sale in this branch, with the VAT it included." />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <SearchInput
            value={term}
            onChange={(value) => {
              setTerm(value);
              setPage(1);
            }}
            placeholder="Sale number, product or barcode…"
            className="w-full sm:max-w-xs"
          />
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-40" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sales</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="voided">Voided</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(row) => row._id}
          loading={isLoading}
          error={error instanceof Error ? error.message : null}
          onRetry={() => void refetch()}
          meta={data?.meta}
          onPageChange={setPage}
          onRowClick={setOpen}
          emptyTitle="No sales yet"
        />
      </Card>

      {open && (
        <SaleDialog
          key={open._id}
          sale={open}
          currency={currency}
          onClose={() => setOpen(null)}
          onPrint={() => setReceiptFor(open._id)}
          onPrintSale={(id) => setReceiptFor(id)}
        />
      )}
      <ShopReceiptDialog saleId={receiptFor} onClose={() => setReceiptFor(null)} />
    </div>
  );
}

function SaleDialog({
  sale,
  currency,
  onClose,
  onPrint,
  onPrintSale,
}: {
  sale: ShopSale;
  currency: string;
  onClose: () => void;
  onPrint: () => void;
  /** Prints a different sale's receipt - the replacement an exchange created. */
  onPrintSale?: (saleId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [voiding, setVoiding] = React.useState(false);
  const [returning, setReturning] = React.useState(false);
  const [exchanging, setExchanging] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const { data: posConfig } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });

  const voidSale = useMutation({
    mutationFn: () => supershopApi.voidSale(sale._id, reason.trim()),
    onSuccess: (voided) => {
      toast.success(`${voided.saleNumber} voided`, { description: 'Its items are back in stock.' });
      void queryClient.invalidateQueries({ queryKey: ['supershop'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not void the sale'),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {sale.saleNumber} {sale.status === 'voided' && <Badge variant="destructive">Voided</Badge>}
          </DialogTitle>
          <DialogDescription>
            {format(new Date(sale.soldAt), 'd MMM yyyy, HH:mm')} · {sale.cashierNameSnapshot}
          </DialogDescription>
        </DialogHeader>
        <ul className="divide-y text-sm">
          {sale.items.map((line) => (
            <li key={line._id} className="flex justify-between gap-3 py-2">
              <div>
                <p className="font-medium">{line.nameSnapshot}</p>
                <p className="text-xs text-muted-foreground">
                  {formatQuantity(line.quantity, line.unitType)} × {formatMoney(line.unitPriceMinor, currency)}
                  {line.unitType === 'weight' ? '/kg' : ''}
                  {line.barcodeSnapshot ? ` · #${line.barcodeSnapshot}` : ''}
                </p>
              </div>
              <span className="tabular">{formatMoney(line.lineTotalMinor, currency)}</span>
            </li>
          ))}
        </ul>
        <dl className="space-y-1 text-sm">
          {sale.discountMinor > 0 && (
            <div className="flex justify-between">
              <dt>Discount</dt>
              <dd className="tabular">-{formatMoney(sale.discountMinor, currency)}</dd>
            </div>
          )}
          <div className="flex justify-between font-semibold">
            <dt>Total</dt>
            <dd className="tabular">{formatMoney(sale.totalMinor, currency)}</dd>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <dt>VAT included</dt>
            <dd className="tabular">{formatMoney(sale.vatMinor, currency)}</dd>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <dt>Paid ({sale.payments.map((p) => p.method).join(', ')})</dt>
            <dd className="tabular">{formatMoney(sale.paidMinor, currency)}</dd>
          </div>
        </dl>
        {sale.status === 'voided' && (
          <p className="text-sm text-muted-foreground">
            Voided by {sale.voidedByNameSnapshot}
            {sale.voidedAt ? ` on ${format(new Date(sale.voidedAt), 'd MMM yyyy, HH:mm')}` : ''}: {sale.voidReason}
          </p>
        )}
        {voiding && (
          <div className="space-y-1.5">
            <Label htmlFor="void-reason">Why is this sale being voided?</Label>
            <Input id="void-reason" autoFocus value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} />
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onPrint}>
            <Printer />
            Receipt
          </Button>
          {sale.status === 'completed' && !sale.fullyReturned && (
            <PermissionGate anyOf={['returns.create']}>
              <Button variant="outline" onClick={() => setReturning(true)}>
                <Undo2 />
                Return items
              </Button>
            </PermissionGate>
          )}
          {/* An exchange writes a sale as well as a return, so it needs both. */}
          {sale.status === 'completed' && !sale.fullyReturned && (
            <PermissionGate anyOf={['returns.create']}>
              <PermissionGate anyOf={['sales.create']}>
                <Button variant="outline" onClick={() => setExchanging(true)}>
                  <Repeat2 />
                  Exchange
                </Button>
              </PermissionGate>
            </PermissionGate>
          )}
          {sale.status === 'completed' && (
            <PermissionGate anyOf={['sales.cancel']}>
              {voiding ? (
                <Button variant="destructive" disabled={reason.trim().length < 3} loading={voidSale.isPending} onClick={() => voidSale.mutate()}>
                  Confirm void
                </Button>
              ) : (
                <Button variant="destructive" onClick={() => setVoiding(true)}>
                  Void sale
                </Button>
              )}
            </PermissionGate>
          )}
        </DialogFooter>
      </DialogContent>

      {exchanging && (
        <ShopExchangeDialog
          sale={sale}
          currency={currency}
          posConfig={posConfig}
          onClose={() => setExchanging(false)}
          onDone={(replacementSaleId) => {
            setExchanging(false);
            onClose();
            // The exchange receipt is the replacement sale's own.
            onPrintSale?.(replacementSaleId);
          }}
        />
      )}

      {returning && (
        <PosReturnDialog
          saleNumber={sale.saleNumber}
          currency={currency}
          posConfig={posConfig}
          lines={sale.items.map((line) => ({
            _id: line._id,
            label: line.nameSnapshot,
            detail: line.unitType === 'weight' ? 'by weight' : undefined,
            quantity: line.quantity,
            returnedQuantity: line.returnedQuantity,
            unitPriceMinor: line.unitPriceMinor,
          }))}
          onSubmit={(input) => supershopApi.createReturn(sale._id, input)}
          onClose={() => {
            setReturning(false);
            onClose();
          }}
          invalidate={['supershop']}
        />
      )}
    </Dialog>
  );
}
