import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict, format } from 'date-fns';
import { toast } from 'sonner';
import { Check, ChefHat, Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { KitchenTicketDialog } from '@/features/restaurant/RestaurantPrints';
import { ApiError } from '@/api/client';
import { restaurantApi } from '@/api/restaurant';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import type { KitchenQueueTicket } from '@/types/restaurant';

/** The kitchen queue for this branch: what to cook next, oldest first. */
export function KitchenPage() {
  const { activeStore, can } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState<'pending' | 'ready'>('pending');
  const [printing, setPrinting] = React.useState<{ orderId: string; ticketId: string } | null>(null);

  const { data: tickets, isLoading } = useQuery({
    queryKey: ['restaurant', 'kitchen', status],
    queryFn: () => restaurantApi.kitchenTickets(status),
    // A kitchen screen stays open all service; keep it current.
    refetchInterval: 15_000,
  });

  const ready = useMutation({
    mutationFn: (ticket: KitchenQueueTicket) => restaurantApi.markTicketReady(ticket.orderId, ticket._id),
    onSuccess: (_order, ticket) => {
      toast.success(`${ticket.ticketNumber} is ready`);
      void queryClient.invalidateQueries({ queryKey: ['restaurant'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not update the ticket'),
  });

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader title="Kitchen" description={`Kitchen tickets for ${activeStore?.name ?? 'this branch'}. Refreshes every 15 seconds.`} />

      <Tabs value={status} onValueChange={(value) => setStatus(value as 'pending' | 'ready')}>
        <TabsList>
          <TabsTrigger value="pending">To cook</TabsTrigger>
          <TabsTrigger value="ready">Ready (last 12 hours)</TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading && <LoadingState label="Loading tickets…" />}
      {!isLoading && (tickets?.length ?? 0) === 0 && (
        <EmptyState
          icon={<ChefHat className="h-6 w-6" />}
          title={status === 'pending' ? 'Nothing to cook' : 'Nothing marked ready yet'}
          description={status === 'pending' ? 'New tickets appear here when orders are sent to the kitchen.' : undefined}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(tickets ?? []).map((ticket) => {
          const ageMinutes = (Date.now() - new Date(ticket.createdAt).getTime()) / 60_000;
          return (
            <Card key={ticket._id} className={cn(status === 'pending' && ageMinutes > 20 && 'border-destructive/50')}>
              <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
                <div>
                  <CardTitle className="text-lg">
                    {ticket.type === 'takeaway' ? 'Takeaway' : `Table ${ticket.tableNameSnapshot}`}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono">{ticket.ticketNumber}</span> · {ticket.orderNumber} · {ticket.createdByNameSnapshot}
                  </p>
                </div>
                {status === 'pending' ? (
                  <Badge variant={ageMinutes > 20 ? 'destructive' : 'warning'}>
                    {formatDistanceToNowStrict(new Date(ticket.createdAt))}
                  </Badge>
                ) : (
                  <Badge variant="success">Ready {ticket.readyAt ? format(new Date(ticket.readyAt), 'hh:mm a') : ''}</Badge>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-1.5">
                  {ticket.lines.map((line) => (
                    <li key={`${line.lineId}-${line.quantity}`} className="text-base">
                      {line.quantity < 0 ? (
                        <span className="font-semibold text-destructive">
                          VOID {Math.abs(line.quantity)} × {line.nameSnapshot}
                        </span>
                      ) : (
                        <span className="font-semibold">
                          {line.quantity} × {line.nameSnapshot}
                        </span>
                      )}
                      {line.note && <span className="block text-sm text-muted-foreground">» {line.note}</span>}
                    </li>
                  ))}
                </ul>
                {ticket.orderNote && <p className="rounded bg-muted/50 px-2 py-1 text-sm">Note: {ticket.orderNote}</p>}
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setPrinting({ orderId: ticket.orderId, ticketId: ticket._id })}>
                    <Printer />
                    Print
                  </Button>
                  {status === 'pending' && can('sales.create') && (
                    <Button size="sm" className="flex-1" loading={ready.isPending && ready.variables?._id === ticket._id} onClick={() => ready.mutate(ticket)}>
                      <Check />
                      Mark ready
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <KitchenTicketDialog target={printing} onClose={() => setPrinting(null)} />
    </div>
  );
}
