import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, LoadingState } from '@/components/states';
import { platformAccountsApi } from '@/api/endpoints';

/** The customer accounts directory. Opening one asks for a reason and is audited. */
export function AccountsTab() {
  const navigate = useNavigate();
  const [draft, setDraft] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const params = { page, limit: 20, ...(search ? { search } : {}), ...(status !== 'all' ? { status } : {}) };
  const { data, isLoading, isError } = useQuery({ queryKey: ['platform', 'accounts', params], queryFn: () => platformAccountsApi.list(params) });

  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(draft.trim());
          setPage(1);
        }}
      >
        <Input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Account name, contact or owner email" className="w-72" aria-label="Search accounts" />
        <Button type="submit" variant="outline">
          Search
        </Button>
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
      </form>

      {isLoading ? (
        <LoadingState label="Loading accounts…" />
      ) : isError || !data ? (
        <EmptyState title="Could not load accounts" />
      ) : data.items.length === 0 ? (
        <EmptyState title="No accounts found" />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium">Owner</th>
                  <th className="px-4 py-2 text-right font-medium">Workspaces</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((account) => (
                  <tr
                    key={account.id}
                    className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                    onClick={() => navigate(`/platform/accounts/${account.id}`)}
                  >
                    <td className="px-4 py-2">
                      <span className="font-medium">{account.name}</span>
                      {account.contactEmail && <span className="block text-xs text-muted-foreground">{account.contactEmail}</span>}
                    </td>
                    <td className="px-4 py-2">
                      {account.owner?.name ?? '—'}
                      {account.owner && <span className="block text-xs text-muted-foreground">{account.owner.email}</span>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{account.workspaceCount}</td>
                    <td className="px-4 py-2">
                      <Badge variant={account.status === 'active' ? 'success' : 'destructive'}>{account.status}</Badge>
                    </td>
                    <td className="px-4 py-2">{format(new Date(account.createdAt), 'd MMM yyyy')}</td>
                  </tr>
                ))}
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
