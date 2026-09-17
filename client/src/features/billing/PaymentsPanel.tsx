import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, LoadingState } from '@/components/states';
import { invoiceApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL } from './billingLabels';

/** Every subscription payment across the account's workspaces, including pending and failed ones. */
export function PaymentsPanel({
  workspaces,
  fetchPayments = invoiceApi.accountPayments,
  queryScope = 'account',
  invoiceHref = (id: string) => `/billing/invoices/${id}`,
}: {
  workspaces: { id: string; name: string }[];
  fetchPayments?: (params: Record<string, unknown>) => ReturnType<typeof invoiceApi.accountPayments>;
  queryScope?: string;
  invoiceHref?: ((id: string) => string) | null;
}) {
  const [workspaceId, setWorkspaceId] = React.useState('all');
  const [status, setStatus] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const params = { page, limit: 20, ...(workspaceId !== 'all' ? { workspaceId } : {}), ...(status !== 'all' ? { status } : {}) };
  const { data, isLoading, isError } = useQuery({ queryKey: [queryScope, 'payments', params], queryFn: () => fetchPayments(params) });

  const change = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(1);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Select value={workspaceId} onValueChange={change(setWorkspaceId)}>
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
        <Select value={status} onValueChange={change(setStatus)}>
          <SelectTrigger className="w-44" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            {Object.entries(PAYMENT_STATUS_LABEL).map(([value, { label }]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <LoadingState label="Loading payments…" />
      ) : isError || !data ? (
        <EmptyState title="Could not load payments" />
      ) : data.items.length === 0 ? (
        <EmptyState title="No payments yet" />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Workspace</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 font-medium">Method</th>
                  <th className="px-4 py-2 font-medium">Reference</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Invoice</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((payment) => {
                  const badge = PAYMENT_STATUS_LABEL[payment.status] ?? { label: payment.status, variant: 'secondary' as const };
                  return (
                    <tr key={payment.id} className="border-b last:border-0">
                      <td className="px-4 py-2">{format(new Date(payment.paidAt ?? payment.createdAt), 'd MMM yyyy')}</td>
                      <td className="px-4 py-2">{payment.workspaceName ?? '—'}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatMoney(payment.amountMinor, payment.currency)}
                        {payment.refundedMinor > 0 && (
                          <span className="block text-xs text-muted-foreground">−{formatMoney(payment.refundedMinor, payment.currency)} refunded</span>
                        )}
                      </td>
                      <td className="px-4 py-2">{PAYMENT_METHOD_LABEL[payment.method] ?? payment.method}</td>
                      <td className="max-w-[12rem] truncate px-4 py-2 font-mono text-xs" title={payment.reference ?? undefined}>
                        {payment.reference ?? '—'}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        {payment.underReview && <span className="block text-xs text-muted-foreground">Being checked</span>}
                        {payment.failureReason && <span className="block max-w-[14rem] text-xs text-muted-foreground">{payment.failureReason}</span>}
                      </td>
                      <td className="px-4 py-2">
                        {payment.invoice?.number && invoiceHref ? (
                          <Link className="text-primary underline-offset-2 hover:underline" to={invoiceHref(payment.invoice.id)}>
                            {payment.invoice.number}
                          </Link>
                        ) : payment.invoice?.number ? (
                          <span className="font-mono">{payment.invoice.number}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {data && data.meta.totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
            Previous
          </Button>
          <span className="text-muted-foreground">
            Page {data.meta.page} of {data.meta.totalPages}
          </span>
          <Button size="sm" variant="outline" disabled={page >= data.meta.totalPages} onClick={() => setPage((value) => value + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
