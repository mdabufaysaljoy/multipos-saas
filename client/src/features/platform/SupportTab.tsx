import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { platformSupportApi, type PlatformSupportTicket } from '@/api/endpoints';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, LoadingState } from '@/components/states';
import { SUPPORT_AREA_LABELS, SUPPORT_STATUS_LABELS, SUPPORT_TYPE_LABELS } from '@/features/support/supportSchema';

/**
 * The support inbox: every workspace's tickets, in one list.
 *
 * Cross-tenant by design, and the only surface that is - these endpoints sit
 * behind `requirePlatformAdmin` on the server, which is also what refuses them
 * to a store account. Answering a ticket sets where it now stands in the same
 * action, so nothing is replied to and left looking unattended.
 */
export function SupportTab() {
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState('open');
  const [type, setType] = React.useState('all');
  const [draft, setDraft] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);

  const params = {
    page,
    limit: 20,
    ...(status !== 'all' ? { status } : {}),
    ...(type !== 'all' ? { type } : {}),
    ...(search ? { search } : {}),
  };
  const { data, isLoading, isError } = useQuery({
    queryKey: ['platform', 'support', params],
    queryFn: () => platformSupportApi.list(params),
  });
  const { data: counts } = useQuery({ queryKey: ['platform', 'support', 'counts'], queryFn: platformSupportApi.counts });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['platform', 'support'] });
  };

  return (
    <div className="space-y-3">
      {counts && (
        <p className="text-sm text-muted-foreground">
          {counts.open.toLocaleString()} open · {counts.inProgress.toLocaleString()} in progress · {counts.resolved.toLocaleString()} resolved ·{' '}
          {counts.closed.toLocaleString()} closed
        </p>
      )}

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(draft.trim());
          setPage(1);
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Reference or subject"
          className="w-64"
          aria-label="Search tickets"
        />
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
            {Object.entries(SUPPORT_STATUS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={type}
          onValueChange={(value) => {
            setType(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44" aria-label="Kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Problems and features</SelectItem>
            <SelectItem value="problem">Problem reports</SelectItem>
            <SelectItem value="feature">Feature requests</SelectItem>
          </SelectContent>
        </Select>
      </form>

      {isLoading ? (
        <LoadingState label="Loading tickets…" />
      ) : isError || !data ? (
        <EmptyState title="Could not load tickets" />
      ) : data.items.length === 0 ? (
        <EmptyState title="No tickets match these filters" />
      ) : (
        <div className="space-y-3">
          {data.items.map((ticket) => (
            <TicketRow
              key={ticket._id}
              ticket={ticket}
              expanded={openId === ticket._id}
              onToggle={() => setOpenId((current) => (current === ticket._id ? null : ticket._id))}
              onAnswered={refresh}
            />
          ))}
        </div>
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

/** One ticket. Collapsed it is a line in the inbox; opened it is the whole thing plus the reply box. */
function TicketRow({
  ticket,
  expanded,
  onToggle,
  onAnswered,
}: {
  ticket: PlatformSupportTicket;
  expanded: boolean;
  onToggle: () => void;
  onAnswered: () => void;
}) {
  const [reply, setReply] = React.useState(ticket.reply ?? '');
  const [status, setStatus] = React.useState<string>(ticket.status);

  const answer = useMutation({
    mutationFn: () => platformSupportApi.reply(ticket._id, { status, ...(reply.trim() ? { reply: reply.trim() } : {}) }),
    onSuccess: (updated) => {
      toast.success('Ticket updated', { description: `${updated.reference} · ${SUPPORT_STATUS_LABELS[updated.status] ?? updated.status}` });
      onAnswered();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not update the ticket'),
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <button type="button" className="flex w-full flex-wrap items-start justify-between gap-2 text-left" onClick={onToggle}>
          <div className="min-w-0 space-y-1">
            <p className="font-medium">{ticket.subject}</p>
            <p className="text-xs text-muted-foreground">
              {ticket.workspace.name} · {ticket.reference} · {SUPPORT_TYPE_LABELS[ticket.type] ?? ticket.type} ·{' '}
              {SUPPORT_AREA_LABELS[ticket.area] ?? ticket.area} · {format(new Date(ticket.createdAt), 'd MMM yyyy, HH:mm')}
            </p>
          </div>
          <Badge variant={ticket.status === 'resolved' ? 'success' : ticket.status === 'open' ? 'secondary' : 'outline'}>
            {SUPPORT_STATUS_LABELS[ticket.status] ?? ticket.status}
          </Badge>
        </button>

        {expanded && (
          <div className="space-y-3 border-t pt-3">
            <p className="text-xs text-muted-foreground">
              From {ticket.createdByName || 'Unknown'}
              {ticket.createdByEmail && ` · ${ticket.createdByEmail}`}
              {ticket.vertical && ` · ${ticket.vertical} POS`}
            </p>
            <p className="whitespace-pre-wrap text-sm">{ticket.message}</p>

            {ticket.reply && (
              <div className="rounded-lg border bg-muted/40 p-3">
                <p className="text-xs font-medium">
                  Answered by {ticket.repliedByName || 'the platform team'}
                  {ticket.repliedAt && <span className="font-normal text-muted-foreground"> · {format(new Date(ticket.repliedAt), 'd MMM yyyy, HH:mm')}</span>}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{ticket.reply}</p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor={`reply-${ticket._id}`}>Reply to the store</Label>
              <Textarea
                id={`reply-${ticket._id}`}
                rows={5}
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder="What you found, what you changed, or when it will be looked at."
              />
              <p className="text-xs text-muted-foreground">The store sees this on its own Support page. Leave it empty to change the status only.</p>
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor={`status-${ticket._id}`}>Status</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger id={`status-${ticket._id}`} className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(SUPPORT_STATUS_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={() => answer.mutate()} loading={answer.isPending} disabled={answer.isPending}>
                Save
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
