import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Printer, Undo2 } from 'lucide-react';
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
import { PharmacyReceiptDialog } from '@/features/pharmacy/PharmacyReceiptDialog';
import { PosReturnDialog } from '@/features/returns/PosReturnDialog';
import { storeApi } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { pharmacyApi } from '@/api/pharmacy';
import { formatMoney } from '@/lib/money';
import { formatExpiry } from '@/lib/pharmacy';
import { useAuth } from '@/hooks/useAuth';
import type { PharmacySale } from '@/types/pharmacy';

/** Sales in this branch, with the batches each line came from and any prescription. */
export function PharmacySalesPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term);
  const [filter, setFilter] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const [open, setOpen] = React.useState<PharmacySale | null>(null);
  const [receiptFor, setReceiptFor] = React.useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['pharmacy', 'sales', search, filter, page],
    queryFn: () =>
      pharmacyApi.sales({
        page,
        limit: 25,
        ...(search ? { search } : {}),
        ...(filter === 'voided' || filter === 'completed' ? { status: filter } : {}),
        ...(filter === 'prescription' ? { prescriptionOnly: 'true' } : {}),
      }),
  });

  const columns: Column<PharmacySale>[] = [
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
    {
      key: 'items',
      header: 'Medicines',
      mobile: 'hide',
      cell: (row) => (
        <span className="text-sm">
          {row.items
            .slice(0, 3)
            .map((line) => `${line.nameSnapshot} ×${line.quantity}`)
            .join(', ')}
          {row.items.length > 3 ? ` +${row.items.length - 3}` : ''}
        </span>
      ),
    },
    {
      key: 'status',
      header: '',
      mobile: 'meta',
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.status === 'voided' && <Badge variant="destructive">Voided</Badge>}
          {row.prescription && <Badge variant="warning">Rx</Badge>}
        </div>
      ),
    },
    {
      key: 'total',
      header: 'Total',
      className: 'text-right',
      headerClassName: 'text-right',
      cell: (row) => <span className="tabular font-medium">{formatMoney(row.totalMinor, currency)}</span>,
    },
  ];

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader title="Pharmacy sales" description="Every sale in this branch. Voiding a sale returns its stock to the batches it came from." />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <SearchInput
            value={term}
            onChange={(value) => {
              setTerm(value);
              setPage(1);
            }}
            placeholder="Sale number, patient or medicine…"
            className="w-full sm:max-w-xs"
          />
          <Select
            value={filter}
            onValueChange={(value) => {
              setFilter(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-44" aria-label="Filter sales">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sales</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="voided">Voided</SelectItem>
              <SelectItem value="prescription">With prescription</SelectItem>
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
        />
      )}
      <PharmacyReceiptDialog saleId={receiptFor} onClose={() => setReceiptFor(null)} />
    </div>
  );
}

function SaleDialog({ sale, currency, onClose, onPrint }: { sale: PharmacySale; currency: string; onClose: () => void; onPrint: () => void }) {
  const queryClient = useQueryClient();
  const [voiding, setVoiding] = React.useState(false);
  const [returning, setReturning] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const { data: posConfig } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });

  const voidSale = useMutation({
    mutationFn: () => pharmacyApi.voidSale(sale._id, reason.trim()),
    onSuccess: (voided) => {
      toast.success(`${voided.saleNumber} voided`, { description: 'Its stock is back in the batches it came from.' });
      void queryClient.invalidateQueries({ queryKey: ['pharmacy'] });
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
            <li key={line._id} className="py-2">
              <div className="flex justify-between gap-3">
                <span className="font-medium">
                  {line.nameSnapshot} {line.strengthSnapshot} ×{line.quantity}
                </span>
                <span className="tabular">{formatMoney(line.lineTotalMinor, currency)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {line.allocations.map((a) => `${a.quantity} from ${a.batchNumber} (exp ${formatExpiry(a.expiryDate)})`).join(' · ')}
              </p>
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
            <dt>Paid ({sale.payments.map((p) => p.method).join(', ')})</dt>
            <dd className="tabular">{formatMoney(sale.paidMinor, currency)}</dd>
          </div>
        </dl>

        {sale.prescription && (
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">Prescription</p>
            <p>
              Patient {sale.prescription.patientName} · prescriber {sale.prescription.prescriberName}
              {sale.prescription.prescriptionNumber ? ` · No. ${sale.prescription.prescriptionNumber}` : ''}
            </p>
          </div>
        )}
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

      {returning && (
        <PosReturnDialog
          saleNumber={sale.saleNumber}
          currency={currency}
          posConfig={posConfig}
          lines={sale.items.map((line) => ({
            _id: line._id,
            label: `${line.nameSnapshot} ${line.strengthSnapshot}`.trim(),
            // The batch the units came from goes back to that same batch.
            detail: line.allocations[0] ? `Batch ${line.allocations[0].batchNumber}` : undefined,
            quantity: line.quantity,
            returnedQuantity: line.returnedQuantity,
            unitPriceMinor: line.unitPriceMinor,
          }))}
          onSubmit={(input) => pharmacyApi.createReturn(sale._id, input)}
          onClose={() => {
            setReturning(false);
            onClose();
          }}
          invalidate={['pharmacy']}
        />
      )}
    </Dialog>
  );
}
