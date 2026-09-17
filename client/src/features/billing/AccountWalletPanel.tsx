import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/states';
import { accountWalletApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

const SERVICE_FILTERS = [
  { value: '', label: 'All' },
  { value: 'topup', label: 'Top-ups' },
  { value: 'subscription', label: 'Subscription' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
  { value: 'refund', label: 'Refunds' },
  { value: 'adjustment', label: 'Adjustments' },
] as const;
const PAGE_SIZE = 20;

/**
 * The account wallet: balance, spending by service and every transaction,
 * across all of the account's workspaces. Read-only; money is added through
 * the top-up section above it.
 */
export function AccountWalletPanel({ workspaces }: { workspaces: { id: string; name: string }[] }) {
  const [service, setService] = React.useState('');
  const [workspaceId, setWorkspaceId] = React.useState('');
  const [page, setPage] = React.useState(1);
  const names = React.useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces]);

  const summary = useQuery({ queryKey: ['account', 'wallet'], queryFn: () => accountWalletApi.summary() });
  const transactions = useQuery({
    queryKey: ['account', 'wallet', 'transactions', service, workspaceId, page],
    queryFn: () => accountWalletApi.transactions({ page, limit: PAGE_SIZE, ...(service ? { service } : {}), ...(workspaceId ? { workspaceId } : {}) }),
  });

  if (summary.isLoading) return <LoadingState label="Loading the wallet…" />;
  if (summary.isError || !summary.data) return <EmptyState title="Could not load the wallet" />;
  const wallet = summary.data;
  const totalPages = transactions.data?.meta.totalPages ?? 1;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs text-muted-foreground">Current balance</p>
            <p className="text-xl font-semibold tabular-nums">{formatMoney(wallet.balanceMinor, wallet.currency)}</p>
            <p className={cn('text-xs', wallet.isFrozen ? 'text-destructive' : 'text-muted-foreground')}>
              {wallet.isFrozen ? 'Frozen. Contact support.' : wallet.pendingTopUps > 0 ? `${wallet.pendingTopUps} top-up(s) awaiting verification` : 'Shared by all your workspaces'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs text-muted-foreground">Money added</p>
            <p className="text-xl font-semibold tabular-nums">{formatMoney(wallet.totalCreditsMinor, wallet.currency)}</p>
            <p className="text-xs text-muted-foreground">Refunds {formatMoney(wallet.totalRefundsMinor, wallet.currency)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs text-muted-foreground">Spent</p>
            <p className="text-xl font-semibold tabular-nums">{formatMoney(wallet.totalDebitsMinor, wallet.currency)}</p>
            <p className="text-xs text-muted-foreground">
              Funding: {[...wallet.fundingMethods.manual, ...wallet.fundingMethods.online.filter((method) => method !== 'manual')].join(', ') || '—'}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Spending by service</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-4">
          {wallet.services.map((row) => (
            <div key={row.service} className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">{row.label}</p>
              <p className="font-semibold tabular-nums">{formatMoney(row.amountMinor, wallet.currency)}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
          <CardTitle className="text-base">Transactions</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Workspace"
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={workspaceId}
              onChange={(event) => {
                setWorkspaceId(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All workspaces</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Type">
              {SERVICE_FILTERS.map((filter) => (
                <Button
                  key={filter.value}
                  size="sm"
                  variant={service === filter.value ? 'default' : 'outline'}
                  onClick={() => {
                    setService(filter.value);
                    setPage(1);
                  }}
                >
                  {filter.label}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {transactions.isLoading ? (
            <LoadingState label="Loading transactions…" />
          ) : (transactions.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No transactions" />
          ) : (
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Date</th>
                  <th className="pb-2 font-medium">Description</th>
                  <th className="pb-2 font-medium">Workspace</th>
                  <th className="pb-2 text-right font-medium">Amount</th>
                  <th className="pb-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {transactions.data!.items.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="py-2 whitespace-nowrap">{format(new Date(row.createdAt), 'd MMM yyyy, h:mm a')}</td>
                    <td className="py-2">
                      {row.description}
                      {row.referenceType && <Badge variant="secondary" className="ml-2">{row.referenceType}</Badge>}
                    </td>
                    <td className="py-2">{names.get(row.workspaceId) ?? '—'}</td>
                    <td className={cn('py-2 text-right tabular-nums', row.direction === 'in' ? 'text-emerald-600' : '')}>
                      {row.direction === 'in' ? '+' : '−'}
                      {formatMoney(row.amountMinor, row.currency)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatMoney(row.balanceAfterMinor, row.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-end gap-2 text-sm">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
                Previous
              </Button>
              <span className="text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
