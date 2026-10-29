import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Bug, Lightbulb, LifeBuoy } from 'lucide-react';
import { supportApi } from '@/api/endpoints';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { SupportTicketDialog } from '@/features/support/SupportTicketDialog';
import { SUPPORT_AREA_LABELS, SUPPORT_STATUS_LABELS, SUPPORT_TYPE_LABELS } from '@/features/support/supportSchema';
import type { SupportTicket, SupportTicketStatus } from '@/types/domain';

/**
 * Support: this workspace's own conversation with the platform team.
 *
 * Every ticket on this page belongs to this workspace - the server never takes
 * a workspace from the request, so there is nothing here that could be pointed
 * at somebody else's. Deliberately reachable whatever the subscription says: a
 * lapsed plan is a reason to need support, not a reason to lose it.
 */

const STATUS_VARIANT: Record<SupportTicketStatus, 'secondary' | 'success' | 'outline'> = {
  open: 'secondary',
  in_progress: 'outline',
  resolved: 'success',
  closed: 'outline',
};

export function SupportPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState<'all' | SupportTicketStatus>('all');
  const [composing, setComposing] = React.useState<null | 'problem' | 'feature'>(null);
  const [page, setPage] = React.useState(1);

  const params = { page, limit: 20, ...(status === 'all' ? {} : { status }) };
  const { data, isLoading, isError } = useQuery({
    queryKey: ['support', params],
    queryFn: () => supportApi.list(params),
  });

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Support"
        description="Report a problem or ask for a feature. The platform team answers here."
        actions={
          <PermissionGate anyOf={['support.create']}>
            <Button variant="outline" onClick={() => setComposing('feature')}>
              <Lightbulb />
              Request a feature
            </Button>
            <Button onClick={() => setComposing('problem')}>
              <Bug />
              Report a problem
            </Button>
          </PermissionGate>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value as typeof status);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44" aria-label="Status">
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
      </div>

      {isLoading ? (
        <LoadingState label="Loading your tickets…" />
      ) : isError || !data ? (
        <EmptyState title="Could not load your tickets" description="Try again in a moment." />
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={<LifeBuoy className="h-6 w-6" />}
          title={status === 'all' ? 'Nothing sent yet' : 'Nothing with that status'}
          description={
            status === 'all'
              ? 'When something is wrong, or you need the system to do something it does not do yet, tell us here.'
              : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {data.items.map((ticket) => (
            <TicketCard key={ticket._id} ticket={ticket} />
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

      <SupportTicketDialog
        open={composing !== null}
        initialType={composing ?? 'problem'}
        onOpenChange={(open) => setComposing(open ? composing : null)}
        onSent={() => {
          setPage(1);
          void queryClient.invalidateQueries({ queryKey: ['support'] });
        }}
      />
    </div>
  );
}

/** One ticket, with the team's answer underneath it when there is one. */
function TicketCard({ ticket }: { ticket: SupportTicket }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <p className="font-medium">{ticket.subject}</p>
            <p className="text-xs text-muted-foreground">
              {ticket.reference} · {SUPPORT_TYPE_LABELS[ticket.type] ?? ticket.type} · {SUPPORT_AREA_LABELS[ticket.area] ?? ticket.area} ·{' '}
              {format(new Date(ticket.createdAt), 'd MMM yyyy, HH:mm')} · {ticket.createdByName || 'Unknown'}
            </p>
          </div>
          <Badge variant={STATUS_VARIANT[ticket.status] ?? 'secondary'}>{SUPPORT_STATUS_LABELS[ticket.status] ?? ticket.status}</Badge>
        </div>

        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{ticket.message}</p>

        {ticket.reply ? (
          <div className="rounded-lg border bg-muted/40 p-3">
            <p className="text-xs font-medium">
              Platform team
              {ticket.repliedAt && <span className="font-normal text-muted-foreground"> · {format(new Date(ticket.repliedAt), 'd MMM yyyy, HH:mm')}</span>}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{ticket.reply}</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No reply yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
