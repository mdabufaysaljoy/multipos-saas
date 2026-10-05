import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ArrowDownToLine, ArrowUpFromLine, Lock, Printer, Unlock } from 'lucide-react';
import { toast } from 'sonner';
import { pharmacyApi } from '@/api/pharmacy';
import { ApiError } from '@/api/client';
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
import { MoneyInput } from '@/components/MoneyInput';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { LoadingState } from '@/components/states';
import { ReceiptPaper } from '@/features/receipt/ReceiptPaper';
import { ReceiptPrintBar } from '@/features/receipt/ReceiptPrintBar';
import { useReceiptPrint } from '@/features/receipt/useReceiptPrint';
import { useAuth } from '@/hooks/useAuth';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { PharmacyShift, PharmacyShiftDetail } from '@/types/pharmacy';

const message = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

/** Pharmacy cash drawer: live X-report while open and immutable Z-report after close. */
export function PharmacyShiftsPage() {
  const { activeStore, can } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const money = (minor: number) => formatMoney(minor, currency);
  const client = useQueryClient();
  const canRun = can('sales.create');
  const canView = can('reports.view');
  const [page, setPage] = React.useState(1);
  const [opening, setOpening] = React.useState(false);
  const [movement, setMovement] = React.useState<'pay_in' | 'pay_out' | null>(null);
  const [closing, setClosing] = React.useState(false);
  const [report, setReport] = React.useState<PharmacyShiftDetail | null>(null);

  const { data: current, isLoading } = useQuery({
    queryKey: ['pharmacy', 'shift', 'current'],
    queryFn: pharmacyApi.currentShift,
    enabled: canRun,
    refetchInterval: 30_000,
  });
  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['pharmacy', 'shifts', page],
    queryFn: () => pharmacyApi.shifts({ page, limit: 20 }),
    enabled: canView,
  });
  const refresh = () => void client.invalidateQueries({ queryKey: ['pharmacy'] });
  const load = useMutation({
    mutationFn: pharmacyApi.shift,
    onSuccess: setReport,
    onError: (error) => toast.error(message(error, 'Could not load the shift')),
  });

  const columns: Column<PharmacyShift>[] = [
    {
      key: 'number',
      header: 'Shift',
      mobile: 'title',
      cell: (row) => <span className="font-mono text-sm">{row.shiftNumber}</span>,
    },
    {
      key: 'opened',
      header: 'Opened',
      mobile: 'meta',
      cell: (row) => `${format(new Date(row.openedAt), 'd MMM, hh:mm a')} · ${row.openedByNameSnapshot}`,
    },
    {
      key: 'closed',
      header: 'Closed',
      mobile: 'hide',
      cell: (row) =>
        row.closedAt ? format(new Date(row.closedAt), 'd MMM, hh:mm a') : <Badge variant="warning">Open</Badge>,
    },
    {
      key: 'expected',
      header: 'Expected',
      className: 'text-right',
      headerClassName: 'text-right',
      cell: (row) => (row.expectedCashMinor === null ? '—' : money(row.expectedCashMinor)),
    },
    {
      key: 'variance',
      header: 'Variance',
      className: 'text-right',
      headerClassName: 'text-right',
      cell: (row) => <Variance value={row.varianceMinor} currency={currency} />,
    },
  ];

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader
        title="Pharmacy shifts"
        description={`Cash drawer shifts at ${activeStore?.name ?? 'this branch'}.`}
      />
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
              <Button variant="ghost" size="sm" onClick={() => setReport(current)}>
                <Printer />
                X-report
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {isLoading && <LoadingState label="Checking the drawer…" />}
            {!isLoading && !current && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">Count the opening float before the first sale.</p>
                <Button onClick={() => setOpening(true)}>
                  <Unlock />
                  Open shift
                </Button>
              </div>
            )}
            {current && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Opened {format(new Date(current.shift.openedAt), 'd MMM, hh:mm a')} by{' '}
                  {current.shift.openedByNameSnapshot}
                </p>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Figure
                    label="Net sales"
                    value={money(current.report.sales.netSalesMinor)}
                    hint={`${current.report.sales.salesCount} sales`}
                  />
                  <Figure
                    label="Cash sales"
                    value={money(current.report.cash.cashSalesMinor)}
                    hint={`Refunds ${money(current.report.cash.cashRefundsMinor)}`}
                  />
                  <Figure
                    label="Pay-ins / outs"
                    value={`${money(current.report.cash.payInsMinor)} / ${money(current.report.cash.payOutsMinor)}`}
                  />
                  <Figure label="Expected cash" value={money(current.report.cash.expectedCashMinor)} strong />
                </div>
                {(current.shift.cashMovements?.length ?? 0) > 0 && (
                  <ul className="divide-y rounded-md border text-sm">
                    {current.shift.cashMovements!.map((entry) => (
                      <li key={entry._id} className="flex justify-between gap-2 px-3 py-2">
                        <span>
                          {entry.type === 'pay_in' ? 'Pay-in' : 'Pay-out'} · {entry.reason}
                          <span className="block text-xs text-muted-foreground">
                            {format(new Date(entry.at), 'hh:mm a')} · {entry.byNameSnapshot}
                          </span>
                        </span>
                        <span className={cn('tabular font-medium', entry.type === 'pay_out' && 'text-destructive')}>
                          {entry.type === 'pay_out' ? '−' : '+'}
                          {money(entry.amountMinor)}
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
      {canView && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Shift history</CardTitle>
          </CardHeader>
          <DataTable
            columns={columns}
            rows={history?.items ?? []}
            rowKey={(row) => row._id}
            loading={historyLoading}
            meta={history?.meta}
            onPageChange={setPage}
            onRowClick={(row) => load.mutate(row._id)}
            emptyTitle="No shifts yet"
            emptyDescription="Closed shifts and their Z-reports appear here."
          />
        </Card>
      )}
      <AmountDialog
        open={opening}
        title="Open shift"
        description="Count the cash already in the drawer."
        amountLabel="Opening float"
        confirm="Open shift"
        onClose={() => setOpening(false)}
        onSubmit={(amount, note) => pharmacyApi.openShift({ openingFloatMinor: amount, note })}
        onDone={(payload) => {
          setOpening(false);
          client.setQueryData(['pharmacy', 'shift', 'current'], payload);
          toast.success(`${payload.shift.shiftNumber} opened`);
          refresh();
        }}
      />
      {current && movement && (
        <MovementDialog
          type={movement}
          shiftId={current.shift._id}
          onClose={() => setMovement(null)}
          onDone={(payload) => {
            client.setQueryData(['pharmacy', 'shift', 'current'], payload);
            setMovement(null);
            refresh();
          }}
        />
      )}
      {current && (
        <AmountDialog
          open={closing}
          title={`Close ${current.shift.shiftNumber}`}
          description={`Expected cash: ${money(current.report.cash.expectedCashMinor)}. Count every note and coin; closing is final.`}
          amountLabel="Counted cash"
          confirm="Close and show Z-report"
          onClose={() => setClosing(false)}
          onSubmit={(amount, note) => pharmacyApi.closeShift(current.shift._id, { countedCashMinor: amount, note })}
          onDone={(payload) => {
            setClosing(false);
            client.setQueryData(['pharmacy', 'shift', 'current'], null);
            setReport(payload);
            refresh();
          }}
        />
      )}
      <ReportDialog payload={report} currency={currency} onClose={() => setReport(null)} />
    </div>
  );
}

function Figure({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className={cn('rounded-md border p-3', strong && 'border-primary/40 bg-primary/5')}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Variance({ value, currency }: { value: number | null; currency: string }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  if (value === 0) return <span className="text-success">Balanced</span>;
  return (
    <span className={value < 0 ? 'text-destructive' : 'text-warning'}>
      {value < 0 ? 'Short ' : 'Over '}
      {formatMoney(Math.abs(value), currency)}
    </span>
  );
}

function AmountDialog({
  open,
  title,
  description,
  amountLabel,
  confirm,
  onClose,
  onSubmit,
  onDone,
}: {
  open: boolean;
  title: string;
  description: string;
  amountLabel: string;
  confirm: string;
  onClose: () => void;
  onSubmit: (amount: number, note: string) => Promise<PharmacyShiftDetail>;
  onDone: (payload: PharmacyShiftDetail) => void;
}) {
  const [amount, setAmount] = React.useState<number | null>(null);
  const [note, setNote] = React.useState('');
  React.useEffect(() => {
    if (open) {
      setAmount(null);
      setNote('');
    }
  }, [open]);
  const mutation = useMutation({
    mutationFn: () => onSubmit(amount ?? 0, note.trim()),
    onSuccess: onDone,
    onError: (error) => toast.error(message(error, 'Could not update the shift')),
  });
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{amountLabel}</Label>
            <MoneyInput value={amount} onChange={setAmount} ariaLabel={amountLabel} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shift-note">Note (optional)</Label>
            <Input id="shift-note" value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={amount === null} loading={mutation.isPending} onClick={() => mutation.mutate()}>
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MovementDialog({
  type,
  shiftId,
  onClose,
  onDone,
}: {
  type: 'pay_in' | 'pay_out';
  shiftId: string;
  onClose: () => void;
  onDone: (payload: PharmacyShiftDetail) => void;
}) {
  const [amount, setAmount] = React.useState<number | null>(null);
  const [reason, setReason] = React.useState('');
  const mutation = useMutation({
    mutationFn: () => pharmacyApi.addCashMovement(shiftId, { type, amountMinor: amount ?? 0, reason: reason.trim() }),
    onSuccess: onDone,
    onError: (error) => toast.error(message(error, 'Could not record the cash movement')),
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{type === 'pay_in' ? 'Pay in' : 'Pay out'}</DialogTitle>
          <DialogDescription>
            Record cash physically {type === 'pay_in' ? 'added to' : 'removed from'} the drawer.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Amount</Label>
            <MoneyInput value={amount} onChange={setAmount} ariaLabel="Amount" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cash-reason">Reason</Label>
            <Input
              id="cash-reason"
              value={reason}
              maxLength={200}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!amount || reason.trim().length < 3}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReportDialog({
  payload,
  currency,
  onClose,
}: {
  payload: PharmacyShiftDetail | null;
  currency: string;
  onClose: () => void;
}) {
  const receiptHost = React.useRef<HTMLDivElement>(null);
  const print = useReceiptPrint({
    host: receiptHost,
    documentId: payload ? `${payload.shift._id}:${payload.shift.status}` : null,
    ready: Boolean(payload),
  });
  if (!payload) return null;
  const { shift, report } = payload;
  const money = (minor: number) => formatMoney(minor, currency);
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader className="print:hidden">
          <DialogTitle>{shift.status === 'closed' ? 'Z-report' : 'X-report'}</DialogTitle>
        </DialogHeader>
        <div ref={receiptHost} className="rounded-md bg-muted/30 p-2">
        <ReceiptPaper widthMm={payload.store?.receipt?.paperWidthMm}>
          <div className="r-center r-bold">{payload.store?.name ?? 'Pharmacy'}</div>
          <div className="r-center">{shift.status === 'closed' ? 'Z-REPORT' : 'X-REPORT'}</div>
          <div className="r-center r-sm">{shift.shiftNumber}</div>
          <div className="r-rule" />
          <p>Opened: {format(new Date(shift.openedAt), 'd MMM yyyy, hh:mm a')}</p>
          <p>Cashier: {shift.openedByNameSnapshot}</p>
          <div className="r-rule" />
          <table>
            <tbody>
              <tr>
                <td>Sales ({report.sales.salesCount})</td>
                <td className="r-right">{money(report.sales.netSalesMinor)}</td>
              </tr>
              <tr>
                <td>Discounts</td>
                <td className="r-right">{money(report.sales.discountsMinor)}</td>
              </tr>
              <tr>
                <td>Returns ({report.returns.count})</td>
                <td className="r-right">-{money(report.returns.amountMinor)}</td>
              </tr>
              <tr>
                <td>Voids ({report.voids.sales})</td>
                <td className="r-right">{money(report.voids.valueMinor)}</td>
              </tr>
            </tbody>
          </table>
          <div className="r-rule" />
          <table>
            <tbody>
              <tr>
                <td>Opening float</td>
                <td className="r-right">{money(report.cash.openingFloatMinor)}</td>
              </tr>
              <tr>
                <td>Cash sales</td>
                <td className="r-right">{money(report.cash.cashSalesMinor)}</td>
              </tr>
              <tr>
                <td>Cash refunds</td>
                <td className="r-right">-{money(report.cash.cashRefundsMinor)}</td>
              </tr>
              <tr>
                <td>Pay-ins</td>
                <td className="r-right">{money(report.cash.payInsMinor)}</td>
              </tr>
              <tr>
                <td>Pay-outs</td>
                <td className="r-right">-{money(report.cash.payOutsMinor)}</td>
              </tr>
              <tr className="r-bold">
                <td>Expected cash</td>
                <td className="r-right">{money(report.cash.expectedCashMinor)}</td>
              </tr>
              {report.cash.countedCashMinor !== null && (
                <>
                  <tr>
                    <td>Counted cash</td>
                    <td className="r-right">{money(report.cash.countedCashMinor)}</td>
                  </tr>
                  <tr className="r-bold">
                    <td>Variance</td>
                    <td className="r-right">{money(report.cash.varianceMinor ?? 0)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
          <div className="r-rule" />
          {report.byPaymentMethod.map((row) => (
            <div key={row.method} className="flex justify-between">
              <span>
                {row.method} ({row.count})
              </span>
              <span>{money(row.amountMinor)}</span>
            </div>
          ))}
        </ReceiptPaper>
        </div>
        <ReceiptPrintBar print={print} />
        <DialogFooter className="print:hidden">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={print.print} loading={print.direct && print.status === 'printing'}>
            <Printer />
            {print.direct ? 'Print directly' : 'Print'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
