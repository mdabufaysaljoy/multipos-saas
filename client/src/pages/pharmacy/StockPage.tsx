import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { ApiError } from '@/api/client';
import { pharmacyApi } from '@/api/pharmacy';
import { formatMoney } from '@/lib/money';
import { expiryTone, formatExpiry } from '@/lib/pharmacy';
import { useAuth } from '@/hooks/useAuth';
import type { MedicineBatch, StockMovement } from '@/types/pharmacy';

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const MOVEMENT_LABELS: Record<StockMovement['type'], string> = {
  receive: 'Received',
  sale: 'Sold',
  void: 'Sale voided',
  adjust: 'Count corrected',
  write_off: 'Written off',
};

const medicineOf = (batch: MedicineBatch) => (batch.medicineId && typeof batch.medicineId === 'object' ? batch.medicineId : null);

/** Batches in this branch: what is expiring, what has expired, and every stock change. */
export function StockPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState<'in_stock' | 'expiring' | 'expired'>('expiring');
  const [days, setDays] = React.useState('90');
  const [page, setPage] = React.useState(1);
  const [adjusting, setAdjusting] = React.useState<MedicineBatch | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['pharmacy', 'batches', status, days, page],
    queryFn: () => pharmacyApi.batches({ status, page, limit: 25, ...(status === 'expiring' ? { days } : {}) }),
  });
  const { data: movements } = useQuery({
    queryKey: ['pharmacy', 'movements'],
    queryFn: () => pharmacyApi.movements({ limit: 20 }),
  });

  const columns: Column<MedicineBatch>[] = [
    {
      key: 'medicine',
      header: 'Medicine',
      mobile: 'title',
      cell: (row) => {
        const medicine = medicineOf(row);
        return (
          <div>
            <p className="font-medium">
              {medicine?.name ?? 'Removed medicine'} <span className="text-muted-foreground">{medicine?.strength}</span>
            </p>
            <p className="font-mono text-xs text-muted-foreground">{row.batchNumber}</p>
          </div>
        );
      },
    },
    {
      key: 'expiry',
      header: 'Expiry',
      cell: (row) => {
        const tone = expiryTone(row.expiryDate);
        return (
          <div>
            <p>{formatExpiry(row.expiryDate)}</p>
            <Badge variant={tone.variant}>{tone.label}</Badge>
          </div>
        );
      },
    },
    { key: 'onHand', header: 'On hand', className: 'text-right', headerClassName: 'text-right', cell: (row) => <span className="tabular">{row.quantityOnHand}</span> },
    {
      key: 'value',
      header: 'Cost value',
      mobile: 'hide',
      className: 'text-right',
      headerClassName: 'text-right',
      cell: (row) => <span className="tabular">{formatMoney(row.quantityOnHand * row.costPriceMinor, currency)}</span>,
    },
    { key: 'supplier', header: 'Supplier', mobile: 'hide', cell: (row) => row.supplierName || '—' },
    {
      key: 'actions',
      header: '',
      mobile: 'actions',
      className: 'text-right',
      cell: (row) => (
        <PermissionGate anyOf={['inventory.adjust']}>
          <Button size="sm" variant="outline" onClick={() => setAdjusting(row)}>
            Adjust
          </Button>
        </PermissionGate>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader title="Stock & expiry" description="Stock is sold earliest expiry first. Expired stock is never sold; write it off here." />

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as typeof status);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-48" aria-label="Which batches">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="expiring">Expiring soon</SelectItem>
              <SelectItem value="expired">Expired, still on the shelf</SelectItem>
              <SelectItem value="in_stock">All batches in stock</SelectItem>
            </SelectContent>
          </Select>
          {status === 'expiring' && (
            <Select
              value={days}
              onValueChange={(value) => {
                setDays(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-40" aria-label="Within">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30">Within 30 days</SelectItem>
                <SelectItem value="90">Within 90 days</SelectItem>
                <SelectItem value="180">Within 180 days</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(row) => row._id}
          loading={isLoading}
          error={error ? errorMessage(error, 'Could not load stock') : null}
          onRetry={() => void refetch()}
          meta={data?.meta}
          onPageChange={setPage}
          emptyTitle={status === 'expired' ? 'Nothing expired on the shelf' : 'No batches here'}
          emptyDescription={status === 'expiring' ? 'Nothing expires in this window.' : undefined}
        />
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recent stock changes</CardTitle>
        </CardHeader>
        <CardContent>
          {(movements?.items ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No stock changes yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {(movements?.items ?? []).map((movement) => (
                <li key={movement._id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p>
                      <span className="font-medium">{MOVEMENT_LABELS[movement.type]}</span> · {movement.medicineNameSnapshot}{' '}
                      <span className="font-mono text-xs">{movement.batchNumberSnapshot}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(movement.createdAt), 'd MMM, HH:mm')} · {movement.createdByNameSnapshot}
                      {movement.referenceNumber ? ` · ${movement.referenceNumber}` : ''}
                      {movement.reason ? ` · ${movement.reason}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={movement.quantity < 0 ? 'tabular text-destructive' : 'tabular text-success'}>
                      {movement.quantity > 0 ? `+${movement.quantity}` : movement.quantity}
                    </p>
                    <p className="text-xs text-muted-foreground">left {movement.balanceAfter}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {adjusting && (
        <AdjustDialog
          key={adjusting._id}
          batch={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            setAdjusting(null);
            void queryClient.invalidateQueries({ queryKey: ['pharmacy'] });
          }}
        />
      )}
    </div>
  );
}

function AdjustDialog({ batch, onClose, onSaved }: { batch: MedicineBatch; onClose: () => void; onSaved: () => void }) {
  const expired = expiryTone(batch.expiryDate).variant === 'destructive';
  const [type, setType] = React.useState<'write_off' | 'adjust'>(expired ? 'write_off' : 'adjust');
  const [amount, setAmount] = React.useState(expired ? String(batch.quantityOnHand) : '');
  const [reason, setReason] = React.useState(expired ? 'Expired' : '');

  // A write-off names how many to remove; a correction names the counted total.
  const delta = type === 'write_off' ? -Number(amount || 0) : Number(amount || 0) - batch.quantityOnHand;

  const save = useMutation({
    mutationFn: () => pharmacyApi.adjustBatch(batch._id, { type, quantityDelta: delta, reason: reason.trim() }),
    onSuccess: (result) => {
      toast.success(`Batch ${result.batch.batchNumber} now has ${result.batch.quantityOnHand}`);
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not adjust the batch')),
  });

  const valid =
    amount !== '' && delta !== 0 && reason.trim().length >= 3 && (type === 'adjust' || Number(amount) <= batch.quantityOnHand);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust batch {batch.batchNumber}</DialogTitle>
          <DialogDescription>
            {batch.quantityOnHand} on hand · expiry {formatExpiry(batch.expiryDate)}. Every adjustment is recorded with your name.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select
            value={type}
            onValueChange={(value) => {
              setType(value as typeof type);
              setAmount('');
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="write_off">Write off (expired, damaged, lost)</SelectItem>
              <SelectItem value="adjust">Correct the count</SelectItem>
            </SelectContent>
          </Select>
          <div className="space-y-1.5">
            <Label htmlFor="adjust-amount">{type === 'write_off' ? 'Units to remove' : 'Units actually counted'}</Label>
            <Input id="adjust-amount" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value.replace(/\D/g, '').slice(0, 7))} />
            {amount !== '' && <p className="text-xs text-muted-foreground">Change: {delta > 0 ? `+${delta}` : delta}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="adjust-reason">Reason</Label>
            <Input id="adjust-reason" value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={type === 'write_off' ? 'destructive' : 'default'} disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {type === 'write_off' ? 'Write off' : 'Save count'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
