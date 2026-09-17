import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { MoneyInput } from '@/components/MoneyInput';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { format } from 'date-fns';
import { ArrowLeft, Eye, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { ApiError } from '@/api/client';
import { platformAccountsApi, type PlatformAccountOverview, platformWalletApi, type PlatformLedgerRow } from '@/api/endpoints';
import { InvoicesPanel } from '@/features/billing/InvoicesPanel';
import { PaymentsPanel } from '@/features/billing/PaymentsPanel';
import { StatementPanel } from '@/features/billing/StatementPanel';
import { PAYMENT_METHOD_LABEL } from '@/features/billing/billingLabels';
import { formatMoney } from '@/lib/money';

const REASON_KEY = (accountId: string) => `platform-support-reason:${accountId}`;
const readReason = (accountId: string) => {
  try {
    return sessionStorage.getItem(REASON_KEY(accountId)) ?? '';
  } catch {
    return '';
  }
};
const saveReason = (accountId: string, reason: string) => {
  try {
    if (reason) sessionStorage.setItem(REASON_KEY(accountId), reason);
    else sessionStorage.removeItem(REASON_KEY(accountId));
  } catch {
    // Private mode: the reason simply lives for this page view.
  }
};
const day = (value: string | null | undefined) => (value ? format(new Date(value), 'd MMM yyyy') : '—');

const SUBSCRIPTION_BADGE: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  active: 'success',
  trialing: 'warning',
  past_due: 'warning',
  cancelled: 'warning',
  expired: 'destructive',
  suspended: 'destructive',
};

/**
 * Platform support view of ONE customer account: read-only. The server
 * requires a reason for every read and records it with the admin's name in
 * the audit log, so the page asks for one before showing anything.
 */
export function PlatformAccountPage() {
  const { accountId = '' } = useParams<{ accountId: string }>();
  const navigate = useNavigate();
  const [reason, setReason] = React.useState(() => readReason(accountId));

  const back = (
    <Button variant="ghost" size="sm" className="-ml-2" onClick={() => navigate('/platform')}>
      <ArrowLeft />
      Back to platform
    </Button>
  );

  if (!reason) {
    return (
      <div className="space-y-4 p-4 lg:p-6">
        {back}
        <ReasonGate
          onSubmit={(value) => {
            saveReason(accountId, value);
            setReason(value);
          }}
        />
      </div>
    );
  }

  return (
    <AccountSupport
      accountId={accountId}
      reason={reason}
      back={back}
      onChangeReason={() => {
        saveReason(accountId, '');
        setReason('');
      }}
    />
  );
}

function ReasonGate({ onSubmit }: { onSubmit: (reason: string) => void }) {
  const [value, setValue] = React.useState('');
  const valid = value.trim().length >= 5;
  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          Why are you opening this account?
        </CardTitle>
        <CardDescription>
          Customer billing data is only shown for a reason, such as a support ticket. Every view is recorded in the audit log with your name and this reason.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="support-reason">Reason</Label>
          <Textarea id="support-reason" rows={3} maxLength={200} value={value} onChange={(event) => setValue(event.target.value)} placeholder="Ticket #1234: customer asks about a missing top-up" />
        </div>
        <Button disabled={!valid} onClick={() => onSubmit(value.trim())}>
          <Eye />
          Open account
        </Button>
      </CardContent>
    </Card>
  );
}

function AccountSupport({ accountId, reason, back, onChangeReason }: { accountId: string; reason: string; back: React.ReactNode; onChangeReason: () => void }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['platform', 'account', accountId, 'overview', reason],
    queryFn: () => platformAccountsApi.overview(accountId, reason),
  });

  if (isLoading) return <LoadingState label="Opening account…" />;
  if (isError || !data) {
    return (
      <div className="space-y-4 p-4 lg:p-6">
        {back}
        <EmptyState title="Could not open this account" description={error instanceof ApiError ? error.message : undefined} />
        <Button variant="outline" onClick={onChangeReason}>
          Enter a different reason
        </Button>
      </div>
    );
  }

  const workspaces = data.billing.workspaces.map((item) => ({ id: String(item.workspace.id), name: item.workspace.name }));
  const scope = `support:${accountId}:${reason}`;
  const withReason = (params: Record<string, unknown>) => ({ ...params, reason });

  return (
    <div className="min-h-full bg-muted/30">
      <div className="space-y-5 p-4 lg:p-6">
        {back}
        <PageHeader
          title={data.account.name}
          description={`${data.owner?.name ?? 'No owner'} · ${data.owner?.email ?? '—'} · customer since ${day(data.account.createdAt)}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={data.account.status === 'active' ? 'success' : 'destructive'}>{data.account.status}</Badge>
              <Badge variant="secondary">Read-only</Badge>
            </div>
          }
        />
        <p className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-3 text-xs text-muted-foreground">
          <ShieldCheck className="h-4 w-4" />
          Viewing for: <span className="font-medium text-foreground">{reason}</span>. Each section you open is recorded.
          <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={onChangeReason}>
            Change reason
          </Button>
        </p>

        <Tabs defaultValue="overview">
          <TabsList className="flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="wallet">Wallet ledger</TabsTrigger>
            <TabsTrigger value="statement">Statement</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="receipts">Receipts</TabsTrigger>
            <TabsTrigger value="top-ups">Top-ups</TabsTrigger>
            <TabsTrigger value="history">Support access</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <Overview data={data} />
          </TabsContent>
          <TabsContent value="wallet">
            <WalletLedgerAdmin accountId={accountId} reason={reason} scope={scope} />
          </TabsContent>
          <TabsContent value="statement">
            <StatementPanel workspaces={workspaces} queryScope={scope} linkDocuments={false} fetchStatement={(params) => platformAccountsApi.statement(accountId, withReason(params))} />
          </TabsContent>
          <TabsContent value="invoices">
            <InvoicesPanel workspaces={workspaces} queryScope={scope} invoiceHref={null} fetchInvoices={(params) => platformAccountsApi.invoices(accountId, withReason(params))} />
          </TabsContent>
          <TabsContent value="payments">
            <PaymentsPanel workspaces={workspaces} queryScope={scope} invoiceHref={null} fetchPayments={(params) => platformAccountsApi.payments(accountId, withReason(params))} />
          </TabsContent>
          <TabsContent value="receipts">
            <ReceiptsTable accountId={accountId} reason={reason} scope={scope} />
          </TabsContent>
          <TabsContent value="top-ups">
            <TopUpsTable accountId={accountId} reason={reason} scope={scope} />
          </TabsContent>
          <TabsContent value="history">
            <SupportHistory data={data} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function Overview({ data }: { data: PlatformAccountOverview }) {
  const { billing } = data;
  const currency = billing.wallet?.currency ?? billing.upcoming.currency;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Figure label="Wallet balance" value={billing.wallet ? formatMoney(billing.wallet.balanceMinor, billing.wallet.currency) : '—'} hint={billing.wallet?.isFrozen ? 'Frozen' : undefined} />
        <Figure label={`Renewing in ${billing.upcoming.windowDays} days`} value={formatMoney(billing.upcoming.dueMinor, currency)} hint={billing.upcoming.shortfallMinor > 0 ? `Short by ${formatMoney(billing.upcoming.shortfallMinor, currency)}` : undefined} />
        <Figure label="Workspaces active" value={`${billing.totals.active} of ${billing.totals.workspaces}`} hint={billing.totals.needsAttention > 0 ? `${billing.totals.needsAttention} need attention` : undefined} />
        <Figure label="Top-ups awaiting review" value={String(data.pendingTopUps)} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Contact</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm sm:grid-cols-2">
          <p>Owner: {data.owner ? `${data.owner.name} (${data.owner.email})` : '—'}{data.owner && !data.owner.isActive ? ' · inactive' : ''}</p>
          <p>Owner phone: {data.owner?.phone || '—'}</p>
          <p>Billing email: {data.account.contactEmail || '—'}</p>
          <p>Billing phone: {data.account.contactPhone || '—'}</p>
          <p>Country: {data.account.country || '—'}</p>
          <p>Free trial used: {data.account.trialUsed ? 'Yes' : 'No'}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Workspaces</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Workspace</th>
                <th className="px-4 py-2 font-medium">Plan</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Period ends</th>
                <th className="px-4 py-2 font-medium">Renewal</th>
                <th className="px-4 py-2 font-medium">Needs attention</th>
              </tr>
            </thead>
            <tbody>
              {billing.workspaces.map((item) => (
                <tr key={String(item.workspace.id)} className="border-b last:border-0 align-top">
                  <td className="px-4 py-2">
                    <Link className="font-medium text-primary underline-offset-2 hover:underline" to={`/platform/workspaces/${item.workspace.id}`}>
                      {item.workspace.name}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {item.workspace.vertical} · {item.workspace.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {item.subscription ? `${item.subscription.planName ?? item.subscription.planCode} · ${item.subscription.billingCycle}` : 'No plan'}
                    {item.subscription?.priceMinor != null && (
                      <span className="block text-xs text-muted-foreground">{formatMoney(item.subscription.priceMinor, item.subscription.currency ?? currency)}</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {item.subscription ? <Badge variant={SUBSCRIPTION_BADGE[item.subscription.status] ?? 'secondary'}>{item.subscription.status}</Badge> : '—'}
                  </td>
                  <td className="px-4 py-2">{day(item.subscription?.currentPeriodEnd)}</td>
                  <td className="px-4 py-2">
                    {item.renewal.renewsAutomatically ? 'Automatic' : 'Manual'}
                    {item.renewal.graceEndsAt && <span className="block text-xs text-destructive">In grace until {day(item.renewal.graceEndsAt)}</span>}
                    {item.renewal.failedRenewalAttempts > 0 && <span className="block text-xs text-destructive">{item.renewal.failedRenewalAttempts} failed attempt(s)</span>}
                    {item.renewal.scheduledChange && <span className="block text-xs text-muted-foreground">Switching to {item.renewal.scheduledChange.planName}</span>}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {item.attention.length === 0 ? '—' : item.attention.map((reason) => <Badge key={reason} variant="warning">{reason.replace(/_/g, ' ')}</Badge>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function ReceiptsTable({ accountId, reason, scope }: { accountId: string; reason: string; scope: string }) {
  const { data, isLoading } = useQuery({ queryKey: [scope, 'receipts'], queryFn: () => platformAccountsApi.receipts(accountId, { reason, limit: 50 }) });
  if (isLoading) return <LoadingState label="Loading receipts…" />;
  if (!data || data.items.length === 0) return <EmptyState title="No receipts" />;
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Receipt</th>
              <th className="px-4 py-2 font-medium">Date</th>
              <th className="px-4 py-2 font-medium">Workspace</th>
              <th className="px-4 py-2 font-medium">Method</th>
              <th className="px-4 py-2 font-medium">Transaction</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((receipt) => (
              <tr key={receipt.id} className="border-b last:border-0">
                <td className="px-4 py-2 font-mono">{receipt.number}</td>
                <td className="px-4 py-2">{day(receipt.issuedAt)}</td>
                <td className="px-4 py-2">{receipt.workspace.name}</td>
                <td className="px-4 py-2">
                  {PAYMENT_METHOD_LABEL[receipt.payment.method] ?? receipt.payment.method}
                  {receipt.payment.senderLast4 && <span className="block text-xs text-muted-foreground">•••• {receipt.payment.senderLast4}</span>}
                </td>
                <td className="px-4 py-2 font-mono text-xs">{receipt.payment.transactionId}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatMoney(receipt.amountMinor, receipt.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function TopUpsTable({ accountId, reason, scope }: { accountId: string; reason: string; scope: string }) {
  const { data, isLoading } = useQuery({ queryKey: [scope, 'top-ups'], queryFn: () => platformAccountsApi.topUps(accountId, { reason, limit: 50 }) });
  if (isLoading) return <LoadingState label="Loading top-ups…" />;
  if (!data || data.items.length === 0) return <EmptyState title="No top-up requests" />;
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Requested</th>
              <th className="px-4 py-2 font-medium">Workspace</th>
              <th className="px-4 py-2 font-medium">Method</th>
              <th className="px-4 py-2 font-medium">Transaction</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((topUp) => (
              <tr key={topUp.id} className="border-b last:border-0">
                <td className="px-4 py-2">{day(topUp.createdAt)}</td>
                <td className="px-4 py-2">{topUp.workspaceName ?? '—'}</td>
                <td className="px-4 py-2">{PAYMENT_METHOD_LABEL[topUp.paymentMethod] ?? topUp.paymentMethod}</td>
                <td className="px-4 py-2 font-mono text-xs">{topUp.transactionId}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatMoney(topUp.amountMinor, topUp.currency)}</td>
                <td className="px-4 py-2">
                  <Badge variant={topUp.status === 'approved' ? 'success' : topUp.status === 'pending' ? 'warning' : 'secondary'}>{topUp.status}</Badge>
                  {topUp.receipt?.number && <span className="block font-mono text-xs text-muted-foreground">{topUp.receipt.number}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function SupportHistory({ data }: { data: PlatformAccountOverview }) {
  if (data.supportHistory.length === 0) return <EmptyState title="No support access recorded" />;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Recent support access</CardTitle>
        <CardDescription>Who opened this account's billing, when, and why. The full record is in the platform audit log.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {data.supportHistory.map((entry) => (
            <li key={entry.id} className="flex flex-wrap gap-x-3 py-2">
              <span className="text-muted-foreground">{format(new Date(entry.at), 'd MMM yyyy, h:mm a')}</span>
              <span className="font-medium">{entry.actorName}</span>
              <Badge variant="secondary">{entry.section ?? 'view'}</Badge>
              <span className="text-muted-foreground">{entry.reason}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-xs text-destructive">{hint}</p>}
      </CardContent>
    </Card>
  );
}

const newOperationKey = () => `adj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * The account wallet ledger for platform staff. Posted rows are never edited:
 * a manual adjustment adds a row, and a correction is a compensating reversal.
 * Both need a written reason and are recorded in the audit log.
 */
function WalletLedgerAdmin({ accountId, reason, scope }: { accountId: string; reason: string; scope: string }) {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [adjustOpen, setAdjustOpen] = React.useState(false);
  const [reversing, setReversing] = React.useState<PlatformLedgerRow | null>(null);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: [scope, 'wallet', page],
    queryFn: () => platformWalletApi.ledger(accountId, { reason, page, limit: 25 }),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: [scope] });

  if (isLoading) return <LoadingState label="Loading the wallet ledger…" />;
  if (isError || !data) return <EmptyState title="Could not load the wallet" description={error instanceof ApiError ? error.message : undefined} />;
  if (!data.wallet) return <EmptyState title="This account has no wallet yet" />;
  const totalPages = Math.max(1, Math.ceil(data.total / data.limit));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          Balance <strong className="tabular-nums">{formatMoney(data.wallet.balanceMinor, data.wallet.currency)}</strong>
          <Badge variant={data.wallet.status === 'active' ? 'success' : 'destructive'} className="ml-2">
            {data.wallet.status}
          </Badge>
        </div>
        <Button size="sm" onClick={() => setAdjustOpen(true)}>
          Adjust balance
        </Button>
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Type / source</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 font-medium">By</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-right font-medium">Balance</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((row) => {
                const incoming = row.balanceAfterMinor >= row.balanceBeforeMinor;
                const reversible = !row.reversalOfTransactionId && row.type !== 'transfer_in' && row.type !== 'transfer_out';
                return (
                  <tr key={row.id} className="border-b last:border-0 align-top">
                    <td className="whitespace-nowrap px-3 py-2">{format(new Date(row.createdAt), 'd MMM yyyy, h:mm a')}</td>
                    <td className="px-3 py-2">
                      {row.type}
                      <span className="block text-xs text-muted-foreground">{row.source}</span>
                    </td>
                    <td className="px-3 py-2">
                      {row.description}
                      {row.reversalOfTransactionId && <span className="block text-xs text-muted-foreground">Reverses {row.reversalOfTransactionId}</span>}
                      {row.idempotencyKey && <span className="block font-mono text-[11px] text-muted-foreground">{row.idempotencyKey}</span>}
                    </td>
                    <td className="px-3 py-2">{row.performedByName}</td>
                    <td className={cn('px-3 py-2 text-right tabular-nums', incoming ? 'text-success' : 'text-destructive')}>
                      {incoming ? '+' : '−'}
                      {formatMoney(row.amountMinor, row.currency)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(row.balanceAfterMinor, row.currency)}</td>
                    <td className="px-3 py-2 text-right">
                      {reversible && (
                        <Button size="sm" variant="ghost" onClick={() => setReversing(row)}>
                          Reverse
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
            Previous
          </Button>
          <span className="text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>
            Next
          </Button>
        </div>
      )}

      <AdjustDialog open={adjustOpen} onOpenChange={setAdjustOpen} accountId={accountId} currency={data.wallet.currency} onDone={refresh} />
      <ReverseDialog row={reversing} onClose={() => setReversing(null)} accountId={accountId} onDone={refresh} />
    </div>
  );
}

function AdjustDialog({ open, onOpenChange, accountId, currency, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; accountId: string; currency: string; onDone: () => void }) {
  const [direction, setDirection] = React.useState<'credit' | 'debit'>('credit');
  const [source, setSource] = React.useState<'admin_adjustment' | 'promotional_credit'>('admin_adjustment');
  const [amountMinor, setAmountMinor] = React.useState<number | null>(null);
  const [note, setNote] = React.useState('');
  // One key per dialog opening: a double click or a retry cannot move money twice.
  const [operationKey, setOperationKey] = React.useState(newOperationKey);

  React.useEffect(() => {
    if (open) {
      setDirection('credit');
      setSource('admin_adjustment');
      setAmountMinor(null);
      setNote('');
      setOperationKey(newOperationKey());
    }
  }, [open]);

  const adjust = useMutation({
    mutationFn: () => platformWalletApi.adjust(accountId, { direction, amountMinor: amountMinor ?? 0, reason: note.trim(), source: direction === 'debit' ? 'admin_adjustment' : source, idempotencyKey: operationKey }),
    onSuccess: (result) => {
      toast.success(result.replayed ? 'That adjustment was already made' : 'Balance adjusted', { description: `New balance ${formatMoney(result.balanceMinor, currency)}` });
      onOpenChange(false);
      onDone();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not adjust the balance'),
  });

  const valid = (amountMinor ?? 0) > 0 && note.trim().length >= 10;

  return (
    <Dialog open={open} onOpenChange={(next) => !adjust.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust the wallet balance</DialogTitle>
          <DialogDescription>Adds a new ledger row. Your name, the reason and the amount are recorded in the audit log.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Direction</Label>
              <Select value={direction} onValueChange={(value) => setDirection(value as 'credit' | 'debit')}>
                <SelectTrigger aria-label="Direction">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="credit">Add money</SelectItem>
                  <SelectItem value="debit">Remove money</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Amount</Label>
              <MoneyInput value={amountMinor} onChange={setAmountMinor} ariaLabel="Adjustment amount" />
            </div>
          </div>
          {direction === 'credit' && (
            <div className="space-y-1.5">
              <Label>Kind</Label>
              <Select value={source} onValueChange={(value) => setSource(value as 'admin_adjustment' | 'promotional_credit')}>
                <SelectTrigger aria-label="Kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin_adjustment">Admin adjustment</SelectItem>
                  <SelectItem value="promotional_credit">Promotional credit</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="adjust-reason">Reason (at least 10 characters)</Label>
            <Textarea id="adjust-reason" rows={3} maxLength={250} value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={adjust.isPending}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={adjust.isPending} onClick={() => adjust.mutate()}>
            {direction === 'credit' ? 'Add money' : 'Remove money'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReverseDialog({ row, onClose, accountId, onDone }: { row: PlatformLedgerRow | null; onClose: () => void; accountId: string; onDone: () => void }) {
  const [note, setNote] = React.useState('');
  React.useEffect(() => setNote(''), [row]);
  const reverse = useMutation({
    mutationFn: () => platformWalletApi.reverse(accountId, row!.id, { reason: note.trim() }),
    onSuccess: (result) => {
      toast.success('Transaction reversed', { description: `New balance ${formatMoney(result.balanceMinor, result.transaction.currency)}` });
      onClose();
      onDone();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not reverse the transaction'),
  });

  return (
    <Dialog open={Boolean(row)} onOpenChange={(next) => !next && !reverse.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reverse this transaction?</DialogTitle>
          <DialogDescription>
            {row ? `${row.description} (${formatMoney(row.amountMinor, row.currency)}). ` : ''}
            The original stays as it is; an opposite, linked transaction is added. A transaction can be reversed once.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reverse-reason">Reason (at least 10 characters)</Label>
          <Textarea id="reverse-reason" rows={3} maxLength={250} value={note} onChange={(event) => setNote(event.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={reverse.isPending}>
            Keep it
          </Button>
          <Button variant="destructive" disabled={note.trim().length < 10} loading={reverse.isPending} onClick={() => reverse.mutate()}>
            Reverse
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
