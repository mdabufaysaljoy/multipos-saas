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
import { INVOICE_STATUS } from './billingLabels';

interface WorkspaceOption {
  id: string;
  name: string;
}

/** Every invoice across the account's workspaces, newest first. */
export function InvoicesPanel({
  workspaces,
  fetchInvoices = invoiceApi.accountInvoices,
  queryScope = 'account',
  invoiceHref = (id: string) => `/billing/invoices/${id}`,
}: {
  workspaces: WorkspaceOption[];
  /** Where the invoices come from: the owner's own API by default, the platform support API otherwise. */
  fetchInvoices?: (params: Record<string, unknown>) => ReturnType<typeof invoiceApi.accountInvoices>;
  queryScope?: string;
  /** Link for an invoice number; null shows plain text. */
  invoiceHref?: ((id: string) => string) | null;
}) {
  const [workspaceId, setWorkspaceId] = React.useState('all');
  const [status, setStatus] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const params = { page, limit: 20, ...(workspaceId !== 'all' ? { workspaceId } : {}), ...(status !== 'all' ? { status } : {}) };
  const { data, isLoading, isError } = useQuery({ queryKey: [queryScope, 'invoices', params], queryFn: () => fetchInvoices(params) });

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
            <SelectItem value="paid">Paid</SelectItem>
            <SelectItem value="partially_refunded">Partly refunded</SelectItem>
            <SelectItem value="refunded">Refunded</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <LoadingState label="Loading invoices…" />
      ) : isError || !data ? (
        <EmptyState title="Could not load invoices" />
      ) : data.items.length === 0 ? (
        <EmptyState title="No invoices yet" description="An invoice is issued for every subscription payment." />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Invoice</th>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Workspace</th>
                  <th className="px-4 py-2 font-medium">Plan</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((invoice) => {
                  const badge = INVOICE_STATUS[invoice.status] ?? { label: invoice.status, variant: 'secondary' as const };
                  return (
                    <tr key={invoice.id} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        {invoiceHref ? (
                          <Link className="font-medium text-primary underline-offset-2 hover:underline" to={invoiceHref(invoice.id)}>
                            {invoice.number}
                          </Link>
                        ) : (
                          <span className="font-mono font-medium">{invoice.number}</span>
                        )}
                      </td>
                      <td className="px-4 py-2">{format(new Date(invoice.issuedAt), 'd MMM yyyy')}</td>
                      <td className="px-4 py-2">{invoice.workspace.name}</td>
                      <td className="px-4 py-2">
                        {invoice.planName ?? '—'}
                        {invoice.billingCycle ? ` · ${invoice.billingCycle === 'annual' ? 'Annual' : 'Monthly'}` : ''}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatMoney(invoice.totalMinor, invoice.currency)}
                        {invoice.refundedMinor > 0 && (
                          <span className="block text-xs text-muted-foreground">−{formatMoney(invoice.refundedMinor, invoice.currency)} refunded</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
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
