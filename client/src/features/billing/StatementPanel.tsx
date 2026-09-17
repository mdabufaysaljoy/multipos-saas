import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Download, Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, LoadingState } from '@/components/states';
import { statementApi, type AccountStatement } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { PAYMENT_METHOD_LABEL, STATEMENT_CATEGORY_LABEL, csvCell, minorToPlain } from './billingLabels';

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

function downloadCsv(statement: AccountStatement) {
  const header = ['Date', 'Workspace', 'Category', 'Description', 'Reference', 'Money in', 'Money out', 'Balance after', 'Currency'];
  const lines = [
    header.map(csvCell).join(','),
    ['', '', '', 'Opening balance', '', '', '', minorToPlain(statement.openingBalanceMinor), statement.currency].map(csvCell).join(','),
    ...statement.entries.map((entry) =>
      [
        format(new Date(entry.at), 'yyyy-MM-dd HH:mm'),
        entry.workspace.name,
        STATEMENT_CATEGORY_LABEL[entry.category] ?? entry.category,
        entry.description,
        entry.reference?.label ?? '',
        entry.direction === 'in' ? minorToPlain(entry.amountMinor) : '',
        entry.direction === 'out' ? minorToPlain(entry.amountMinor) : '',
        entry.balanceAfterMinor === null ? '' : minorToPlain(entry.balanceAfterMinor),
        statement.currency,
      ]
        .map(csvCell)
        .join(','),
    ),
    ['', '', '', 'Closing balance', '', minorToPlain(statement.moneyInMinor), minorToPlain(statement.moneyOutMinor), minorToPlain(statement.closingBalanceMinor), statement.currency]
      .map(csvCell)
      .join(','),
  ];
  const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `statement-${isoDay(new Date(statement.period.from))}-to-${isoDay(new Date(statement.period.to))}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The account statement: opening balance, every wallet movement with its
 * running balance, closing balance - straight from the ledger - plus the
 * subscription payments made outside the wallet.
 */
export function StatementPanel({
  workspaces,
  fetchStatement = statementApi.account,
  queryScope = 'account',
  linkDocuments = true,
}: {
  workspaces: { id: string; name: string }[];
  fetchStatement?: (params: Record<string, unknown>) => ReturnType<typeof statementApi.account>;
  queryScope?: string;
  /** Whether receipt and invoice numbers link to the owner's document pages. */
  linkDocuments?: boolean;
}) {
  const today = new Date();
  const [from, setFrom] = React.useState(isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))));
  const [to, setTo] = React.useState(isoDay(today));
  const [workspaceId, setWorkspaceId] = React.useState('all');
  const params = { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(workspaceId !== 'all' ? { workspaceId } : {}) };
  const { data, isLoading, isError, error } = useQuery({ queryKey: [queryScope, 'statement', params], queryFn: () => fetchStatement(params) });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 print:hidden">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="statement-from">From</Label>
          <Input id="statement-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="statement-to">To</Label>
          <Input id="statement-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Workspace</Label>
          <Select value={workspaceId} onValueChange={setWorkspaceId}>
            <SelectTrigger className="w-56" aria-label="Workspace">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All workspaces</SelectItem>
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" disabled={!data} onClick={() => data && downloadCsv(data)}>
            <Download />
            CSV
          </Button>
          <Button size="sm" variant="outline" disabled={!data} onClick={() => window.print()}>
            <Printer />
            Print
          </Button>
        </div>
      </div>

      {isLoading ? (
        <LoadingState label="Building statement…" />
      ) : isError || !data ? (
        <EmptyState title="Could not build the statement" description={error instanceof Error ? error.message : undefined} />
      ) : (
        <div id="statement-print-area" className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                Account statement · {format(new Date(data.period.from), 'd MMM yyyy')} – {format(new Date(data.period.to), 'd MMM yyyy')}
                {data.reconciled === true && <Badge variant="success">Reconciled with the ledger</Badge>}
                {data.reconciled === false && <Badge variant="destructive">Does not reconcile - contact support</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-4">
              <Figure label="Opening balance" value={formatMoney(data.openingBalanceMinor, data.currency)} />
              <Figure label="Money in" value={formatMoney(data.moneyInMinor, data.currency)} tone="in" />
              <Figure label="Money out" value={formatMoney(data.moneyOutMinor, data.currency)} tone="out" />
              <Figure label="Closing balance" value={formatMoney(data.closingBalanceMinor, data.currency)} />
              {data.workspaceId && (
                <p className="text-xs text-muted-foreground sm:col-span-4">
                  Balances are for the whole account wallet, which all workspaces share; money in and out are for the selected workspace.
                </p>
              )}
              {data.truncated && <p className="text-xs text-destructive sm:col-span-4">This period has more movements than one statement shows. Choose a shorter period.</p>}
            </CardContent>
          </Card>

          {data.entries.length === 0 ? (
            <EmptyState title="No wallet movements in this period" />
          ) : (
            <Card>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="border-b text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">Date</th>
                      <th className="px-4 py-2 font-medium">Workspace</th>
                      <th className="px-4 py-2 font-medium">Description</th>
                      <th className="px-4 py-2 font-medium">Reference</th>
                      <th className="px-4 py-2 text-right font-medium">In</th>
                      <th className="px-4 py-2 text-right font-medium">Out</th>
                      {!data.workspaceId && <th className="px-4 py-2 text-right font-medium">Balance</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries.map((entry) => (
                      <tr key={entry.id} className="border-b last:border-0">
                        <td className="whitespace-nowrap px-4 py-2">{format(new Date(entry.at), 'd MMM yyyy, h:mm a')}</td>
                        <td className="px-4 py-2">{entry.workspace.name}</td>
                        <td className="px-4 py-2">
                          <span className="block">{entry.description}</span>
                          <span className="text-xs text-muted-foreground">{STATEMENT_CATEGORY_LABEL[entry.category] ?? entry.category}</span>
                        </td>
                        <td className="px-4 py-2">
                          {linkDocuments && entry.reference?.kind === 'receipt' && entry.reference.id ? (
                            <Link className="text-primary underline-offset-2 hover:underline" to={`/billing/receipts/${entry.reference.id}`}>
                              {entry.reference.label}
                            </Link>
                          ) : linkDocuments && entry.reference?.kind === 'invoice' && entry.reference.id ? (
                            <Link className="text-primary underline-offset-2 hover:underline" to={`/billing/invoices/${entry.reference.id}`}>
                              {entry.reference.label}
                            </Link>
                          ) : (
                            (entry.reference?.label ?? '—')
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-success">{entry.direction === 'in' ? formatMoney(entry.amountMinor, data.currency) : ''}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-destructive">{entry.direction === 'out' ? formatMoney(entry.amountMinor, data.currency) : ''}</td>
                        {!data.workspaceId && (
                          <td className="px-4 py-2 text-right tabular-nums">{entry.balanceAfterMinor === null ? '' : formatMoney(entry.balanceAfterMinor, data.currency)}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {data.paidOutsideWallet.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Subscription payments made outside the wallet</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <p className="mb-2 text-xs text-muted-foreground">Paid directly by bKash, bank or another method. They did not change the wallet balance.</p>
                <table className="w-full min-w-[520px] text-sm">
                  <tbody>
                    {data.paidOutsideWallet.map((row) => (
                      <tr key={row.id} className="border-t">
                        <td className="py-2">{format(new Date(row.issuedAt), 'd MMM yyyy')}</td>
                        <td className="py-2">{row.workspace.name}</td>
                        <td className="py-2">
                          {linkDocuments ? (
                            <Link className="text-primary underline-offset-2 hover:underline" to={`/billing/invoices/${row.id}`}>
                              {row.number}
                            </Link>
                          ) : (
                            <span className="font-mono">{row.number}</span>
                          )}
                        </td>
                        <td className="py-2">{PAYMENT_METHOD_LABEL[row.method] ?? row.method}</td>
                        <td className="py-2 text-right tabular-nums">{formatMoney(row.amountMinor, row.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'in' | 'out' }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums', tone === 'in' && 'text-success', tone === 'out' && 'text-destructive')}>{value}</p>
    </div>
  );
}
