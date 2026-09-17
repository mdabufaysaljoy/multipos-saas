import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { ArrowDownToLine, ArrowUpFromLine, Lock, Printer, Unlock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DataTable, type Column } from '@/components/DataTable';
import { LoadingState } from '@/components/states';
import { MoneyInput } from '@/components/MoneyInput';
import { PageHeader } from '@/components/PageHeader';
import { ShiftReportDialog } from '@/features/restaurant/RestaurantPrints';
import { ApiError } from '@/api/client';
import { restaurantApi } from '@/api/restaurant';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import type { RestaurantShift, ShiftPayload } from '@/types/restaurant';

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Open the drawer, record cash in/out, count it at the end, print the Z-report. */
export function ShiftsPage() {
  const { activeStore, can } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const money = (minor: number) => formatMoney(minor, currency);
  const queryClient = useQueryClient();
  const canRun = can('sales.create');
  const canHistory = can('reports.view');

  const [page, setPage] = React.useState(1);
  const [opening, setOpening] = React.useState(false);
  const [movement, setMovement] = React.useState<'pay_in' | 'pay_out' | null>(null);
  const [closing, setClosing] = React.useState(false);
  const [printing, setPrinting] = React.useState<ShiftPayload | null>(null);

  const { data: current, isLoading } = useQuery({
    queryKey: ['restaurant', 'shift', 'current'],
    queryFn: restaurantApi.currentShift,
    enabled: canRun,
    refetchInterval: 30_000,
  });
  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['restaurant', 'shifts', page],
    queryFn: () => restaurantApi.shifts({ page, limit: 20 }),
    enabled: canHistory,
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['restaurant'] });

  const viewShift = useMutation({
    mutationFn: (id: string) => restaurantApi.shift(id),
    onSuccess: setPrinting,
    onError: (err) => toast.error(errorMessage(err, 'Could not load the shift')),
  });

  const columns: Column<RestaurantShift>[] = [
    { key: 'number', header: 'Shift', mobile: 'title', cell: (s) => <span className="font-mono text-sm">{s.shiftNumber}</span> },
    {
      key: 'when',
      header: 'Opened',
      mobile: 'meta',
      cell: (s) => `${format(new Date(s.openedAt), 'd MMM, hh:mm a')} · ${s.openedByNameSnapshot}`,
    },
    {
      key: 'closed',
      header: 'Closed',
      mobile: 'hide',
      cell: (s) => (s.closedAt ? format(new Date(s.closedAt), 'd MMM, hh:mm a') : <Badge variant="warning">Open</Badge>),
    },
    {
      key: 'expected',
      header: 'Expected',
      className: 'text-right',
      headerClassName: 'text-right',
      cell: (s) => <span className="tabular">{s.expectedCashMinor === null ? '—' : money(s.expectedCashMinor)}</span>,
    },
    {
      key: 'variance',
      header: 'Variance',
      className: 'text-right',
      headerClassName: 'text-right',
      cell: (s) => <Variance minor={s.varianceMinor} currency={currency} />,
    },
  ];

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader title="Shifts" description={`Cash drawer shifts at ${activeStore?.name ?? 'this branch'}.`} />

      {canRun && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-base">
              {current ? (
                <span className="flex items-center gap-2">
                  Current shift <span className="font-mono text-sm">{current.shift.shiftNumber}</span>
                  <Badge variant="success">Open</Badge>
                </span>
              ) : (
                'No shift open'
              )}
            </CardTitle>
            {current && (
              <Button variant="ghost" size="sm" onClick={() => setPrinting(current)}>
                <Printer />
                X-report
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {isLoading && <LoadingState label="Checking the drawer…" />}
            {!isLoading && !current && (
              <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted-foreground">
                  Open a shift with the cash float in the drawer. Payments taken while it is open are counted against it.
                </p>
                <Button onClick={() => setOpening(true)}>
                  <Unlock />
                  Open shift
                </Button>
              </div>
            )}
            {current && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Opened {format(new Date(current.shift.openedAt), 'd MMM, hh:mm a')} by {current.shift.openedByNameSnapshot}
                </p>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Figure label="Net sales" value={money(current.report.sales.netSalesMinor)} hint={`${current.report.sales.paidOrders} paid orders`} />
                  <Figure label="Cash sales" value={money(current.report.cash.cashSalesMinor)} />
                  <Figure
                    label="Pay-ins / outs"
                    value={`${money(current.report.cash.payInsMinor)} / ${money(current.report.cash.payOutsMinor)}`}
                  />
                  <Figure label="Expected in drawer" value={money(current.report.cash.expectedCashMinor)} strong />
                </div>
                {current.report.openOrders.orders > 0 && (
                  <p className="rounded-md bg-warning/10 px-3 py-2 text-sm">
                    {current.report.openOrders.orders} order{current.report.openOrders.orders === 1 ? ' is' : 's are'} still open (
                    {money(current.report.openOrders.valueMinor)}). Settle or cancel them before closing if you can.
                  </p>
                )}
                {(current.shift.cashMovements?.length ?? 0) > 0 && (
                  <ul className="divide-y rounded-md border text-sm">
                    {current.shift.cashMovements!.map((m) => (
                      <li key={m._id} className="flex items-center justify-between gap-2 px-3 py-2">
                        <span>
                          {m.type === 'pay_in' ? 'Pay-in' : 'Pay-out'} · {m.reason}
                          <span className="block text-xs text-muted-foreground">
                            {format(new Date(m.at), 'hh:mm a')} · {m.byNameSnapshot}
                          </span>
                        </span>
                        <span className={cn('tabular font-medium', m.type === 'pay_out' && 'text-destructive')}>
                          {m.type === 'pay_out' ? '−' : '+'}
                          {money(m.amountMinor)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setMovement('pay_in')}>
                    <ArrowDownToLine />
                    Pay in
                  </Button>
                  <Button variant="outline" onClick={() => setMovement('pay_out')}>
                    <ArrowUpFromLine />
                    Pay out
                  </Button>
                  <Button className="ml-auto" onClick={() => setClosing(true)}>
                    <Lock />
                    Close shift
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canHistory && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Shift history</CardTitle>
          </CardHeader>
          <DataTable
            columns={columns}
            rows={history?.items ?? []}
            rowKey={(s) => s._id}
            loading={historyLoading}
            meta={history?.meta}
            onPageChange={setPage}
            onRowClick={(s) => viewShift.mutate(s._id)}
            emptyTitle="No shifts yet"
            emptyDescription="Closed shifts and their Z-reports appear here."
          />
        </Card>
      )}

      <OpenShiftDialog
        open={opening}
        onOpenChange={setOpening}
        onOpened={(payload) => {
          toast.success(`${payload.shift.shiftNumber} opened`);
          queryClient.setQueryData(['restaurant', 'shift', 'current'], payload);
          refresh();
        }}
      />
      {current && movement && (
        <CashMovementDialog
          type={movement}
          shiftId={current.shift._id}
          onClose={() => setMovement(null)}
          onDone={(payload) => {
            queryClient.setQueryData(['restaurant', 'shift', 'current'], payload);
            refresh();
          }}
        />
      )}
      {current && (
        <CloseShiftDialog
          open={closing}
          payload={current}
          currency={currency}
          onOpenChange={setClosing}
          onClosed={(payload) => {
            toast.success(`${payload.shift.shiftNumber} closed`);
            queryClient.setQueryData(['restaurant', 'shift', 'current'], null);
            refresh();
            setPrinting(payload);
          }}
        />
      )}
      <ShiftReportDialog payload={printing} onClose={() => setPrinting(null)} />
    </div>
  );
}

function Figure({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className={cn('rounded-md border p-3', strong && 'border-primary/40 bg-primary/5')}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Variance({ minor, currency }: { minor: number | null; currency: string }) {
  if (minor === null) return <span className="text-muted-foreground">—</span>;
  if (minor === 0) return <span className="tabular text-success">Balanced</span>;
  return (
    <span className={cn('tabular font-medium', minor < 0 ? 'text-destructive' : 'text-warning')}>
      {minor < 0 ? 'Short ' : 'Over '}
      {formatMoney(Math.abs(minor), currency)}
    </span>
  );
}

function OpenShiftDialog({
  open,
  onOpenChange,
  onOpened,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpened: (payload: ShiftPayload) => void;
}) {
  const [float, setFloat] = React.useState<number | null>(0);
  const [note, setNote] = React.useState('');
  React.useEffect(() => {
    if (open) {
      setFloat(0);
      setNote('');
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => restaurantApi.openShift({ openingFloatMinor: float ?? 0, note: note.trim() }),
    onSuccess: (payload) => {
      onOpenChange(false);
      onOpened(payload);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not open the shift')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Open shift</DialogTitle>
          <DialogDescription>Count the cash in the drawer before the first sale.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Opening float</Label>
            <MoneyInput value={float} onChange={setFloat} ariaLabel="Opening float" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="open-note">Note (optional)</Label>
            <Input id="open-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={mutation.isPending} onClick={() => mutation.mutate()}>
            Open shift
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CashMovementDialog({
  type,
  shiftId,
  onClose,
  onDone,
}: {
  type: 'pay_in' | 'pay_out';
  shiftId: string;
  onClose: () => void;
  onDone: (payload: ShiftPayload) => void;
}) {
  const [amount, setAmount] = React.useState<number | null>(null);
  const [reason, setReason] = React.useState('');

  const mutation = useMutation({
    mutationFn: () => restaurantApi.cashMovement(shiftId, { type, amountMinor: amount ?? 0, reason: reason.trim() }),
    onSuccess: (payload) => {
      toast.success(type === 'pay_in' ? 'Pay-in recorded' : 'Pay-out recorded');
      onDone(payload);
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not record the cash movement')),
  });

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{type === 'pay_in' ? 'Pay in' : 'Pay out'}</DialogTitle>
          <DialogDescription>
            {type === 'pay_in' ? 'Cash added to the drawer, e.g. more change.' : 'Cash taken out of the drawer, e.g. paying a supplier.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Amount</Label>
            <MoneyInput value={amount} onChange={setAmount} ariaLabel="Amount" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="movement-reason">Reason</Label>
            <Input id="movement-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!amount || reason.trim().length < 3} loading={mutation.isPending} onClick={() => mutation.mutate()}>
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloseShiftDialog({
  open,
  payload,
  currency,
  onOpenChange,
  onClosed,
}: {
  open: boolean;
  payload: ShiftPayload;
  currency: string;
  onOpenChange: (open: boolean) => void;
  onClosed: (payload: ShiftPayload) => void;
}) {
  const [counted, setCounted] = React.useState<number | null>(null);
  const [note, setNote] = React.useState('');
  React.useEffect(() => {
    if (open) {
      setCounted(null);
      setNote('');
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => restaurantApi.closeShift(payload.shift._id, { countedCashMinor: counted ?? 0, note: note.trim() }),
    onSuccess: (closed) => {
      onOpenChange(false);
      onClosed(closed);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not close the shift')),
  });

  // A preview only; the server recomputes the expected cash at the moment of closing.
  const preview = counted === null ? null : counted - payload.report.cash.expectedCashMinor;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Close {payload.shift.shiftNumber}</DialogTitle>
          <DialogDescription>Count every note and coin in the drawer. A closed shift cannot be reopened.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Counted cash</Label>
            <MoneyInput value={counted} onChange={setCounted} ariaLabel="Counted cash" />
          </div>
          {preview !== null && (
            <p className="text-sm">
              Against {formatMoney(payload.report.cash.expectedCashMinor, currency)} expected: <Variance minor={preview} currency={currency} />
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="close-note">Note (optional)</Label>
            <Input id="close-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Explain any difference" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep open
          </Button>
          <Button disabled={counted === null} loading={mutation.isPending} onClick={() => mutation.mutate()}>
            Close and print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
