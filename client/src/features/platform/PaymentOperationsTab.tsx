import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { AlertTriangle, Bell, CalendarClock, CheckCircle2, RefreshCw, Undo2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { DataTable, type Column } from '@/components/DataTable';
import { MoneyInput } from '@/components/MoneyInput';
import { LoadingState } from '@/components/states';
import { ApiError } from '@/api/client';
import { platformApi, type PlatformPaymentRow } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

const QUEUES = [
  { value: 'review', label: 'Needs review' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed & cancelled' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'all', label: 'All payments' },
] as const;

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const statusVariant = (status: string) =>
  status === 'paid' ? 'success' : status === 'pending' ? 'warning' : status === 'refunded' ? 'secondary' : 'destructive';

/**
 * Platform payment operations: the review queue and the few safe actions an
 * admin can take. The server enforces every rule; this screen only asks.
 */
export function PaymentOperationsTab() {
  const [queue, setQueue] = React.useState<(typeof QUEUES)[number]['value']>('review');
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);

  const { data: summary } = useQuery({ queryKey: ['platform', 'payments', 'summary'], queryFn: platformApi.paymentSummary });
  const { data, isLoading } = useQuery({
    queryKey: ['platform', 'payments', queue, page],
    queryFn: () => platformApi.payments({ queue, page, limit: 20 }),
  });

  const columns: Column<PlatformPaymentRow>[] = [
    {
      key: 'tenant',
      mobile: 'title',
      header: 'Workspace',
      cell: (row) => (
        <div>
          <p className="font-medium">{row.tenantId?.name ?? '—'}</p>
          <p className="text-xs text-muted-foreground">{row.planId?.name ?? 'No plan'}</p>
        </div>
      ),
    },
    { key: 'amount', header: 'Amount', cell: (row) => <span className="tabular font-semibold">{formatMoney(row.amountMinor, row.currency)}</span> },
    { key: 'provider', header: 'Provider', mobile: 'hide', cell: (row) => <Badge variant="secondary">{row.provider}</Badge> },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
          {row.review?.required && !row.review.resolvedAt && (
            <Badge variant="warning" className="gap-1">
              <AlertTriangle className="h-3 w-3" />
              Review
            </Badge>
          )}
          {(row.refundedMinor ?? 0) > 0 && row.status !== 'refunded' && <Badge variant="secondary">Part refunded</Badge>}
        </div>
      ),
    },
    {
      key: 'why',
      header: 'Note',
      mobile: 'hide',
      cell: (row) => (
        <span className="line-clamp-2 text-xs text-muted-foreground">
          {row.review?.required && !row.review.resolvedAt ? row.review.reason : row.failureReason ?? ''}
        </span>
      ),
    },
    { key: 'date', header: 'Created', mobile: 'hide', cell: (row) => <span className="text-sm text-muted-foreground">{format(new Date(row.createdAt), 'd MMM yyyy, HH:mm')}</span> },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryTile label="Needs review" value={summary?.review} tone={summary?.review ? 'warning' : undefined} onClick={() => { setQueue('review'); setPage(1); }} />
        <SummaryTile label="Pending" value={summary?.pending} onClick={() => { setQueue('pending'); setPage(1); }} />
        <SummaryTile label="Pending over an hour" value={summary?.stalePending} />
        <SummaryTile label="Failed in the last day" value={summary?.failedLastDay} onClick={() => { setQueue('failed'); setPage(1); }} />
      </div>

      <Card>
        <div className="flex items-center gap-2 border-b p-3">
          <Select value={queue} onValueChange={(value) => { setQueue(value as typeof queue); setPage(1); }}>
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {QUEUES.map((q) => (
                <SelectItem key={q.value} value={q.value}>
                  {q.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(row) => row._id}
          loading={isLoading}
          meta={data?.meta}
          onPageChange={setPage}
          onRowClick={(row) => setOpenId(row._id)}
          emptyTitle={queue === 'review' ? 'Nothing needs review' : 'No payments here'}
        />
      </Card>

      <PaymentAlertsCard />

      <PaymentDetailDialog paymentId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function SummaryTile({ label, value, tone, onClick }: { label: string; value?: number; tone?: 'warning'; onClick?: () => void }) {
  return (
    <Card className={cn(onClick && 'cursor-pointer transition-colors hover:bg-accent/40')} onClick={onClick}>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn('tabular mt-1 text-2xl font-semibold', tone === 'warning' && 'text-warning')}>{value ?? '—'}</p>
      </CardContent>
    </Card>
  );
}

function PaymentDetailDialog({ paymentId, onClose }: { paymentId: string | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['platform', 'payment', paymentId],
    queryFn: () => platformApi.payment(paymentId!),
    enabled: Boolean(paymentId),
  });
  const [action, setAction] = React.useState<'refund' | 'resolve' | 'receive' | 'subscription' | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['platform'] });
  const recheck = useMutation({
    mutationFn: () => platformApi.recheckPayment(paymentId!),
    onSuccess: (result) => {
      const labels: Record<string, string> = {
        activated: 'Confirmed by the provider and activated',
        already_processed: 'Already settled',
        pending: 'The provider still reports it unpaid',
        failed: `The provider did not confirm it: ${result.reason ?? 'failed'}`,
        unverifiable: 'The provider did not confirm the amount; it stays in review',
      };
      (result.outcome === 'activated' ? toast.success : toast.info)(labels[result.outcome] ?? result.outcome);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not re-check the payment')),
  });

  const payment = data?.payment;
  const openReview = payment?.review?.required && !payment.review.resolvedAt;

  return (
    <Dialog open={Boolean(paymentId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        {isLoading || !data || !payment ? (
          <LoadingState label="Loading payment…" />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {formatMoney(payment.amountMinor, payment.currency)}
                <Badge variant={statusVariant(payment.status)}>{payment.status}</Badge>
                <Badge variant="secondary">{payment.provider}</Badge>
              </DialogTitle>
              <DialogDescription>
                {payment.tenantId?.name ?? 'Unknown workspace'} · {payment.planId?.name ?? 'No plan'} · created {format(new Date(payment.createdAt), 'd MMM yyyy, HH:mm')}
              </DialogDescription>
            </DialogHeader>

            {openReview && (
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>
                  <strong>Needs review:</strong> {payment.review!.reason}
                </span>
              </div>
            )}
            {payment.review?.resolvedAt && (
              <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <span>
                  Review resolved by {payment.review.resolvedByNameSnapshot} on {format(new Date(payment.review.resolvedAt), 'd MMM yyyy')}: {payment.review.resolutionNote}
                </span>
              </div>
            )}

            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <Detail label="Provider payment id" value={payment.providerTransactionId ?? '—'} mono />
              <Detail label="Reference" value={payment.providerReference ?? '—'} mono />
              <Detail label="Paid at" value={payment.paidAt ? format(new Date(payment.paidAt), 'd MMM yyyy, HH:mm') : '—'} />
              <Detail label="Initiated by" value={payment.userId ? `${payment.userId.name} (${payment.userId.email})` : '—'} />
              <Detail label="Provider confirmed" value={typeof payment.metadata?.providerAmountMinor === 'number' ? formatMoney(payment.metadata.providerAmountMinor as number, payment.currency) : '—'} />
              <Detail label="Refunded" value={`${formatMoney(payment.refundedMinor ?? 0, payment.currency)} of ${formatMoney(data.refundableMinor, payment.currency)}`} />
              <Detail label="Subscription" value={data.subscription ? `${data.subscription.planSnapshot?.name ?? ''} · ${data.subscription.status}` : '—'} />
              {payment.failureReason && <Detail label="Failure reason" value={payment.failureReason} />}
            </dl>

            {payment.refunds.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Refunds</p>
                <ul className="divide-y rounded-md border text-sm">
                  {payment.refunds.map((refund) => (
                    <li key={refund._id} className="flex justify-between gap-3 px-3 py-2">
                      <span>
                        {refund.reason}
                        <span className="block text-xs text-muted-foreground">
                          {refund.method.replace('_', ' ')} · {refund.reference} · {refund.byNameSnapshot} · {format(new Date(refund.at), 'd MMM yyyy')}
                        </span>
                      </span>
                      <span className="tabular font-medium">−{formatMoney(refund.amountMinor, payment.currency)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {payment.subscriptionAdjustment && (
              <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
                <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {payment.subscriptionAdjustment.action === 'end_now'
                    ? `Access ended on ${format(new Date(payment.subscriptionAdjustment.until), 'd MMM yyyy')}`
                    : `Period shortened to ${format(new Date(payment.subscriptionAdjustment.until), 'd MMM yyyy')} (was ${format(new Date(payment.subscriptionAdjustment.previousEnd), 'd MMM yyyy')})`}{' '}
                  by {payment.subscriptionAdjustment.byNameSnapshot}: {payment.subscriptionAdjustment.reason}
                </span>
              </div>
            )}

            {data.audit.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Admin actions</p>
                <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                  {data.audit.map((entry) => (
                    <li key={entry._id}>
                      {format(new Date(entry.createdAt), 'd MMM yyyy, HH:mm')} · {entry.actorNameSnapshot} · {entry.action}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <DialogFooter className="flex-wrap gap-2 sm:justify-start">
              {payment.status === 'pending' && data.provider.canRecheck && (
                <Button variant="outline" loading={recheck.isPending} onClick={() => recheck.mutate()}>
                  <RefreshCw />
                  Re-check with {payment.provider}
                </Button>
              )}
              {payment.status === 'pending' && !data.provider.canRecheck && (
                <Button variant="outline" onClick={() => setAction('receive')}>
                  <CheckCircle2 />
                  Mark received
                </Button>
              )}
              {payment.status === 'paid' && data.remainingRefundableMinor > 0 && (
                <Button variant="outline" onClick={() => setAction('refund')}>
                  <Undo2 />
                  Record refund
                </Button>
              )}
              {(payment.refundedMinor ?? 0) > 0 && data.subscriptionIsCurrent && !payment.subscriptionAdjustment && (
                <Button variant="outline" onClick={() => setAction('subscription')}>
                  <CalendarClock />
                  Change subscription
                </Button>
              )}
              {openReview && <Button onClick={() => setAction('resolve')}>Resolve review</Button>}
            </DialogFooter>

            {action === 'refund' && (
              <RefundForm paymentId={payment._id} currency={payment.currency} remainingMinor={data.remainingRefundableMinor} onDone={() => { setAction(null); refresh(); }} onCancel={() => setAction(null)} />
            )}
            {action === 'resolve' && <ResolveForm paymentId={payment._id} onDone={() => { setAction(null); refresh(); }} onCancel={() => setAction(null)} />}
            {action === 'subscription' && data.subscription && (
              <SubscriptionActionForm
                paymentId={payment._id}
                currentEnd={data.subscription.currentPeriodEnd}
                onDone={() => { setAction(null); refresh(); }}
                onCancel={() => setAction(null)}
              />
            )}
            {action === 'receive' && (
              <ReceiveForm paymentId={payment._id} priceMinor={payment.amountMinor} onDone={() => { setAction(null); refresh(); }} onCancel={() => setAction(null)} />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** After a refund: stop access now, or cut the paid period short. The workspace sees the reason. */
function SubscriptionActionForm({ paymentId, currentEnd, onDone, onCancel }: { paymentId: string; currentEnd: string; onDone: () => void; onCancel: () => void }) {
  const [mode, setMode] = React.useState<'end_now' | 'shorten'>('end_now');
  const [until, setUntil] = React.useState('');
  const [reason, setReason] = React.useState('');
  const today = format(new Date(), 'yyyy-MM-dd');
  const paidEnd = format(new Date(currentEnd), 'yyyy-MM-dd');

  const save = useMutation({
    mutationFn: () =>
      platformApi.adjustSubscriptionAfterRefund(paymentId, {
        action: mode,
        ...(mode === 'shorten' ? { until: new Date(`${until}T23:59:59`).toISOString() } : {}),
        reason: reason.trim(),
      }),
    onSuccess: (result) => {
      toast.success(mode === 'end_now' ? 'Access ended' : `Subscription now ends ${format(new Date(result.subscription.currentPeriodEnd), 'd MMM yyyy')}`);
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not change the subscription')),
  });
  const valid = reason.trim().length >= 5 && (mode === 'end_now' || (until > today && until < paidEnd));

  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">Change the subscription this payment paid for</p>
      <p className="text-xs text-muted-foreground">Paid until {format(new Date(currentEnd), 'd MMM yyyy')}. The reason is shown to the workspace in its subscription history.</p>
      <Select value={mode} onValueChange={(value) => setMode(value as 'end_now' | 'shorten')}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="end_now">End access now</SelectItem>
          <SelectItem value="shorten">Shorten the paid period</SelectItem>
        </SelectContent>
      </Select>
      {mode === 'shorten' && (
        <div className="space-y-1.5">
          <Label>New end date</Label>
          <Input type="date" min={today} max={paidEnd} value={until} onChange={(e) => setUntil(e.target.value)} />
        </div>
      )}
      <div className="space-y-1.5">
        <Label>Reason shown to the workspace</Label>
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Refunded in full at your request" />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant={mode === 'end_now' ? 'destructive' : 'default'} disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
          {mode === 'end_now' ? 'End access now' : 'Shorten period'}
        </Button>
      </div>
    </div>
  );
}

/** Who gets payment alert digests, and a way to send one right away. */
function PaymentAlertsCard() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['platform', 'settings'], queryFn: platformApi.settings });
  const [enabled, setEnabled] = React.useState(true);
  const [recipients, setRecipients] = React.useState('');

  React.useEffect(() => {
    const alerts = settings?.paymentAlerts as { enabled?: boolean; recipients?: string[] } | undefined;
    if (!alerts) return;
    setEnabled(alerts.enabled !== false);
    setRecipients((alerts.recipients ?? []).join(', '));
  }, [settings]);

  const parsed = recipients.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  const save = useMutation({
    mutationFn: () => platformApi.updateSettings({ paymentAlerts: { enabled, recipients: parsed } }),
    onSuccess: () => {
      toast.success('Alert settings saved');
      void queryClient.invalidateQueries({ queryKey: ['platform', 'settings'] });
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not save alert settings')),
  });
  const sendNow = useMutation({
    mutationFn: platformApi.sendPaymentAlerts,
    onSuccess: (result) => {
      const messages: Record<string, string> = {
        sent: `Digest sent to ${result.delivered} of ${result.recipients} recipients`,
        nothing_to_send: 'Nothing new needs attention',
        disabled: 'Alerts are switched off',
        no_recipients: 'There is nobody to send alerts to',
        not_configured: 'Email is not configured, so nothing was sent. Alerts will go out once it is.',
        failed: `The digest could not be delivered: ${result.error ?? 'unknown error'}. It will be retried.`,
      };
      (result.status === 'sent' ? toast.success : result.status === 'failed' || result.status === 'not_configured' ? toast.error : toast.info)(messages[result.status]);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not send the digest')),
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Payment alert emails</p>
              <p className="text-xs text-muted-foreground">A digest to every platform admin when payments need review or stay pending over an hour. Checked every 10 minutes.</p>
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Payment alerts" />
        </div>
        <div className="space-y-1.5">
          <Label>Also send to</Label>
          <Input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="finance@example.com, ops@example.com" />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" loading={sendNow.isPending} onClick={() => sendNow.mutate()}>
            Send digest now
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('break-all', mono && 'font-mono text-xs')}>{value}</dd>
    </div>
  );
}

function RefundForm({ paymentId, currency, remainingMinor, onDone, onCancel }: { paymentId: string; currency: string; remainingMinor: number; onDone: () => void; onCancel: () => void }) {
  const [amount, setAmount] = React.useState<number | null>(remainingMinor);
  const [method, setMethod] = React.useState('provider_portal');
  const [reference, setReference] = React.useState('');
  const [reason, setReason] = React.useState('');
  const save = useMutation({
    mutationFn: () => platformApi.recordRefund(paymentId, { amountMinor: amount ?? 0, method, reference: reference.trim(), reason: reason.trim() }),
    onSuccess: (payment) => {
      toast.success(payment.status === 'refunded' ? 'Refund recorded; the payment is fully refunded' : 'Refund recorded');
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not record the refund')),
  });
  const valid = Boolean(amount && amount > 0 && amount <= remainingMinor && reference.trim().length >= 3 && reason.trim().length >= 5);

  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">Record a refund already made</p>
      <p className="text-xs text-muted-foreground">
        Refund the customer in the provider&apos;s merchant portal (or by transfer) first, then record it here. Up to {formatMoney(remainingMinor, currency)}.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Amount</Label>
          <MoneyInput value={amount} onChange={setAmount} ariaLabel="Refund amount" />
        </div>
        <div className="space-y-1.5">
          <Label>How it was refunded</Label>
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="provider_portal">Provider merchant portal</SelectItem>
              <SelectItem value="bank_transfer">Bank transfer</SelectItem>
              <SelectItem value="cash">Cash</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Refund reference</Label>
        <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. the bKash refund transaction id" />
      </div>
      <div className="space-y-1.5">
        <Label>Reason</Label>
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>Record refund</Button>
      </div>
    </div>
  );
}

function ResolveForm({ paymentId, onDone, onCancel }: { paymentId: string; onDone: () => void; onCancel: () => void }) {
  const [note, setNote] = React.useState('');
  const save = useMutation({
    mutationFn: () => platformApi.resolvePaymentReview(paymentId, note.trim()),
    onSuccess: () => {
      toast.success('Review resolved');
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not resolve the review')),
  });
  return (
    <div className="space-y-3 rounded-md border p-3">
      <Label>How was this resolved?</Label>
      <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Difference refunded in the bKash portal, reference …" />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button disabled={note.trim().length < 5} loading={save.isPending} onClick={() => save.mutate()}>Resolve</Button>
      </div>
    </div>
  );
}

function ReceiveForm({ paymentId, priceMinor, onDone, onCancel }: { paymentId: string; priceMinor: number; onDone: () => void; onCancel: () => void }) {
  const [amount, setAmount] = React.useState<number | null>(priceMinor);
  const [reference, setReference] = React.useState('');
  const [note, setNote] = React.useState('');
  const save = useMutation({
    mutationFn: () => platformApi.markPaymentReceived(paymentId, { amountReceivedMinor: amount ?? 0, reference: reference.trim(), note: note.trim() }),
    onSuccess: (result) => {
      toast.success(result.outcome === 'activated' ? 'Payment received and plan activated' : `Payment ${result.payment.status}`);
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not mark the payment received')),
  });
  const valid = Boolean(amount && amount >= priceMinor && reference.trim().length >= 3 && note.trim().length >= 5);
  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">Confirm an offline payment was received</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Amount received</Label>
          <MoneyInput value={amount} onChange={setAmount} ariaLabel="Amount received" />
        </div>
        <div className="space-y-1.5">
          <Label>Reference</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>How it was confirmed</Label>
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>Mark received</Button>
      </div>
    </div>
  );
}
