import { TopUpDialog } from './TopUpDialog';
import { Link } from 'react-router-dom';
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ArrowDownLeft, ArrowUpRight, Plus, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PermissionGate } from '@/components/PermissionGate';
import { LoadingState } from '@/components/states';
import { billingApi, walletApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

const SERVICE_COLOURS: Record<string, string> = {
  subscription: 'bg-primary',
  sms: 'bg-success',
  email: 'bg-warning',
  other: 'bg-muted-foreground',
};

const CHARGE_STATUS: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  charged: { label: 'Charged', variant: 'secondary' },
  partially_refunded: { label: 'Part refunded', variant: 'warning' },
  refunded: { label: 'Refunded', variant: 'success' },
  failed: { label: 'Not charged', variant: 'destructive' },
  pending: { label: 'Processing', variant: 'secondary' },
};

/**
 * Billed use of paid services. The unit price shown is the one frozen on each
 * charge when it happened, so a later price change never rewrites history.
 */
function UsageCharges({ currency }: { currency: string }) {
  const { data } = useQuery({ queryKey: ['wallet', 'usage'], queryFn: () => walletApi.usage({ limit: 10 }) });
  if (!data) return null;
  const used = data.summary.filter((row) => row.charges > 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Usage charges</CardTitle>
        <CardDescription>
          SMS, email and other paid services, billed per use from this wallet. Failed sends are refunded automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {used.length > 0 && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {used.map((row) => (
              <div key={row.service} className="rounded-md border p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{row.label}</p>
                <p className="tabular mt-1 font-semibold">{formatMoney(row.netMinor, currency)}</p>
                <p className="tabular text-xs text-muted-foreground">
                  {row.quantity.toLocaleString()} {row.unit}
                  {row.quantity === 1 ? '' : 's'}
                </p>
              </div>
            ))}
          </div>
        )}

        {data.items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No paid services used yet</p>
        ) : (
          <ul className="divide-y">
            {data.items.map((charge) => {
              const status = CHARGE_STATUS[charge.status] ?? CHARGE_STATUS.charged;
              return (
                <li key={charge._id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{charge.description}</p>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {format(new Date(charge.createdAt), 'd MMM yyyy, hh:mm a')} ·{' '}
                      <span className="tabular">
                        {charge.quantity.toLocaleString()} {charge.unit} × {formatMoney(charge.unitPriceMinor, charge.currency)}
                      </span>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tabular text-sm font-semibold">{formatMoney(charge.amountMinor, charge.currency)}</p>
                    {charge.refundedMinor > 0 && (
                      <p className="tabular text-xs text-success">−{formatMoney(charge.refundedMinor, charge.currency)} refunded</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'destructive' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p
          className={cn(
            'tabular mt-1 text-xl font-semibold',
            tone === 'success' && 'text-success',
            tone === 'destructive' && 'text-destructive',
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Prepaid balance used for subscriptions, SMS and email.
 *
 * Top-ups are REQUESTS: the balance only moves once a platform admin verifies
 * the transaction, which the UI states plainly rather than implying instant credit.
 */
export function WalletPanel() {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);

  // Filters for the ledger table.
  const [service, setService] = React.useState('all');
  const [direction, setDirection] = React.useState('all');
  const [sortBy, setSortBy] = React.useState('newest');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');

  const rangeParams = {
    ...(from ? { from: new Date(from).toISOString() } : {}),
    ...(to ? { to: new Date(`${to}T23:59:59`).toISOString() } : {}),
  };

  const { data: wallet, isLoading } = useQuery({ queryKey: ['wallet'], queryFn: walletApi.balance });
  const { data: breakdown } = useQuery({
    queryKey: ['wallet', 'breakdown', rangeParams],
    queryFn: () => walletApi.breakdown(rangeParams),
  });
  const { data: ledger } = useQuery({
    queryKey: ['wallet', 'tx', service, direction, sortBy, rangeParams],
    queryFn: () =>
      walletApi.transactions({
        limit: 25,
        sortBy,
        ...(service !== 'all' ? { service } : {}),
        ...(direction !== 'all' ? { direction } : {}),
        ...rangeParams,
      }),
  });
  const { data: topUps } = useQuery({ queryKey: ['wallet', 'topups'], queryFn: () => walletApi.topUps({ limit: 5 }) });
  const { data: payInfo } = useQuery({ queryKey: ['payment-instructions'], queryFn: billingApi.paymentInstructions });

  const pending = topUps?.items.filter((t) => t.status === 'pending') ?? [];

  if (isLoading || !wallet) return <LoadingState label="Loading wallet…" />;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Wallet className="h-3.5 w-3.5" />
              Wallet balance
            </p>
            <p className="tabular mt-1 text-3xl font-bold">{formatMoney(wallet.balanceMinor, wallet.currency)}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {/* Both figures come from the breakdown, so the header can never
                  disagree with the summary cards below it. */}
              {formatMoney(breakdown?.totalCreditsMinor ?? wallet.lifetimeCreditedMinor, wallet.currency)} added ·{' '}
              {formatMoney(breakdown?.totalDebitsMinor ?? wallet.lifetimeDebitedMinor, wallet.currency)} spent
            </p>
          </div>

          <PermissionGate anyOf={['wallet.manage']}>
            <Button onClick={() => setOpen(true)}>
              <Plus />
              Add money
            </Button>
          </PermissionGate>
        </CardContent>
      </Card>

      {breakdown && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Summary label="Total added" value={formatMoney(breakdown.totalCreditsMinor, wallet.currency)} tone="success" />
          <Summary label="Total spent" value={formatMoney(breakdown.totalDebitsMinor, wallet.currency)} tone="destructive" />
          <Summary label="Refunded back" value={formatMoney(breakdown.totalRefundsMinor, wallet.currency)} />
          <Summary label="Pending top-ups" value={String(pending.length)} />
        </div>
      )}

      {breakdown && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Spending by service</CardTitle>
            <CardDescription>Derived from the ledger, so it always reconciles with the transactions below.</CardDescription>
          </CardHeader>
          <CardContent>
            {breakdown.totalDebitsMinor === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Nothing spent yet</p>
            ) : (
              <ul className="space-y-2.5">
                {breakdown.services.map((row) => {
                  const share =
                    breakdown.totalDebitsMinor > 0 ? Math.round((row.amountMinor / breakdown.totalDebitsMinor) * 100) : 0;
                  return (
                    <li key={row.service} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">{row.label}</span>
                        <span className="tabular">
                          {formatMoney(row.amountMinor, wallet.currency)}
                          <span className="ml-2 text-xs text-muted-foreground">{share}%</span>
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn('h-full rounded-full', SERVICE_COLOURS[row.service] ?? 'bg-muted-foreground')}
                          style={{ width: `${share}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <UsageCharges currency={wallet.currency} />

      {pending.length > 0 && (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="space-y-1 p-4 text-sm">
            {pending.map((topUp) => (
              <div key={topUp._id} className="flex flex-wrap items-center gap-2">
                <Badge variant="warning">Awaiting review</Badge>
                <span>
                  {formatMoney(topUp.amountMinor, topUp.currency)} via {topUp.paymentMethod} —{' '}
                  <span className="font-mono">{topUp.transactionId}</span>. Your balance updates once verified.
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {(topUps?.items.some((t) => t.status !== 'pending') ?? false) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Recent top-ups</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {topUps!.items
                .filter((t) => t.status !== 'pending')
                .map((topUp) => (
                  <li key={topUp._id} className="flex flex-wrap items-center gap-2 py-2 text-sm first:pt-0 last:pb-0">
                    <span className="tabular font-medium">{formatMoney(topUp.amountMinor, topUp.currency)}</span>
                    <span className="text-muted-foreground">
                      {format(new Date(topUp.createdAt), 'd MMM yyyy')} · {topUp.paymentMethod}
                    </span>
                    <Badge variant={topUp.status === 'approved' ? 'success' : 'secondary'}>{topUp.status}</Badge>
                    {topUp.receipt?.id && (
                      <Link className="ml-auto text-primary underline-offset-2 hover:underline" to={`/wallet/receipts/${topUp._id}`}>
                        Receipt {topUp.receipt.number ?? ''}
                      </Link>
                    )}
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Wallet activity</CardTitle>
          <CardDescription>Every movement is recorded — balances are never edited directly.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Service</Label>
              <Select value={service} onValueChange={setService}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All services</SelectItem>
                  <SelectItem value="topup">Top-up</SelectItem>
                  <SelectItem value="subscription">Subscription</SelectItem>
                  <SelectItem value="sms">SMS</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="ai">AI</SelectItem>
                  <SelectItem value="storage">Storage</SelectItem>
                  <SelectItem value="adjustment">Adjustment</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Direction</Label>
              <Select value={direction} onValueChange={setDirection}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="credit">Credit</SelectItem>
                  <SelectItem value="debit">Debit</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Sort</Label>
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest</SelectItem>
                  <SelectItem value="oldest">Oldest</SelectItem>
                  <SelectItem value="highest">Highest amount</SelectItem>
                  <SelectItem value="lowest">Lowest amount</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">From</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" />
            </div>
            {(service !== 'all' || direction !== 'all' || from || to) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setService('all'); setDirection('all'); setFrom(''); setTo(''); }}
              >
                Clear
              </Button>
            )}
          </div>

          {(ledger?.items.length ?? 0) === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No wallet activity yet</p>
          ) : (
            <ul className="divide-y">
              {ledger!.items.map((tx) => {
                const isIn = tx.type === 'credit' || tx.type === 'refund' || (tx.type === 'adjustment' && tx.balanceAfterMinor > tx.balanceBeforeMinor);
                return (
                  <li key={tx._id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                    <span
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                        isIn ? 'bg-success/12 text-success' : 'bg-destructive/12 text-destructive',
                      )}
                    >
                      {isIn ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{tx.reason}</p>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {format(new Date(tx.createdAt), 'd MMM yyyy, hh:mm a')} · {tx.performedByNameSnapshot}
                        {tx.referenceType && <Badge variant="secondary">{tx.referenceType}</Badge>}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={cn('tabular text-sm font-semibold', isIn ? 'text-success' : 'text-destructive')}>
                        {isIn ? '+' : '−'}
                        {formatMoney(tx.amountMinor)}
                      </p>
                      <p className="tabular text-xs text-muted-foreground">{formatMoney(tx.balanceAfterMinor)}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <TopUpDialog
        open={open}
        onOpenChange={setOpen}
        instructions={payInfo?.instructions ?? []}
        submit={(body) => walletApi.requestTopUp({ ...body })}
        onDone={() => {
          void queryClient.invalidateQueries({ queryKey: ['wallet'] });
        }}
      />
    </div>
  );
}
