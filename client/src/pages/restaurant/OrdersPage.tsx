import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Printer, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KitchenTicketDialog, RestaurantReceiptDialog } from '@/features/restaurant/RestaurantPrints';
import { PosReturnDialog } from '@/features/returns/PosReturnDialog';
import { PermissionGate } from '@/components/PermissionGate';
import { storeApi } from '@/api/endpoints';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { restaurantApi } from '@/api/restaurant';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import type { RestaurantOrder } from '@/types/restaurant';

const STATUS: Record<string, { label: string; variant: 'warning' | 'success' | 'secondary' }> = {
  open: { label: 'Open', variant: 'warning' },
  paid: { label: 'Paid', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'secondary' },
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="tabular mt-1 text-xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}

/** Order history for the current branch, with today's trading summary. */
export function OrdersPage() {
  const { activeStore, can } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const [status, setStatus] = React.useState('all');
  const [refunding, setRefunding] = React.useState<RestaurantOrder | null>(null);
  const { data: posConfig } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });
  const [page, setPage] = React.useState(1);
  const [viewing, setViewing] = React.useState<RestaurantOrder | null>(null);
  const [receiptFor, setReceiptFor] = React.useState<string | null>(null);
  const [ticketToPrint, setTicketToPrint] = React.useState<{ orderId: string; ticketId: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['restaurant', 'orders', status, page],
    queryFn: () => restaurantApi.orders({ page, limit: 25, ...(status !== 'all' ? { status } : {}) }),
  });
  const { data: summary } = useQuery({
    queryKey: ['restaurant', 'summary'],
    queryFn: () => restaurantApi.summary(),
    enabled: can('reports.view'),
  });

  const columns: Column<RestaurantOrder>[] = [
    {
      key: 'number',
      header: 'Order',
      mobile: 'title',
      cell: (order) => <span className="font-mono text-sm">{order.orderNumber}</span>,
    },
    {
      key: 'where',
      header: 'Where',
      mobile: 'meta',
      cell: (order) => (order.type === 'takeaway' ? 'Takeaway' : `Table ${order.tableNameSnapshot}`),
    },
    { key: 'items', header: 'Items', cell: (order) => order.items.reduce((sum, line) => sum + line.quantity, 0) },
    {
      key: 'total',
      header: 'Total',
      className: 'text-right',
      headerClassName: 'text-right',
      cell: (order) => <span className="tabular font-medium">{formatMoney(order.totalMinor, currency)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (order) => <Badge variant={STATUS[order.status].variant}>{STATUS[order.status].label}</Badge>,
    },
    {
      key: 'when',
      header: 'Opened',
      mobile: 'hide',
      cell: (order) => format(new Date(order.createdAt), 'd MMM, hh:mm a'),
    },
  ];

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader title="Orders" description={`Dine-in and takeaway orders at ${activeStore?.name ?? 'this branch'}.`} />

      {summary && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Paid today" value={String(summary.paidOrders)} />
          <Stat label="Revenue today" value={formatMoney(summary.revenueMinor, currency)} />
          <Stat label="Average order" value={formatMoney(summary.averageOrderMinor, currency)} />
          <Stat label="Open now" value={String(summary.openOrders)} />
        </div>
      )}

      <Card>
        <div className="flex items-center gap-2 border-b p-3">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All orders</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(order) => order._id}
          loading={isLoading}
          meta={data?.meta}
          onPageChange={setPage}
          onRowClick={setViewing}
          emptyTitle="No orders yet"
          emptyDescription="Orders taken at the point of sale appear here."
        />
      </Card>

      <Dialog open={Boolean(viewing)} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="max-w-md">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="font-mono">{viewing.orderNumber}</span>
                  <Badge variant={STATUS[viewing.status].variant}>{STATUS[viewing.status].label}</Badge>
                </DialogTitle>
                <DialogDescription>
                  {viewing.type === 'takeaway' ? 'Takeaway' : `Table ${viewing.tableNameSnapshot}`} · opened by{' '}
                  {viewing.openedByNameSnapshot} · {format(new Date(viewing.createdAt), 'd MMM yyyy, hh:mm a')}
                </DialogDescription>
              </DialogHeader>
              <ul className="divide-y text-sm">
                {viewing.items.map((line) => (
                  <li key={line._id} className="flex justify-between gap-3 py-2">
                    <span>
                      {line.quantity} × {line.nameSnapshot}
                      <span className="block text-xs text-muted-foreground">{formatMoney(line.unitPriceMinor, currency)} each</span>
                    </span>
                    <span className="tabular">{formatMoney(line.lineTotalMinor, currency)}</span>
                  </li>
                ))}
              </ul>
              <dl className="space-y-1 border-t pt-3 text-sm">
                <div className="flex justify-between"><dt>Subtotal</dt><dd className="tabular">{formatMoney(viewing.subtotalMinor, currency)}</dd></div>
                {viewing.discountMinor > 0 && (
                  <div className="flex justify-between text-warning"><dt>Discount</dt><dd className="tabular">−{formatMoney(viewing.discountMinor, currency)}</dd></div>
                )}
                <div className="flex justify-between font-semibold"><dt>Total</dt><dd className="tabular">{formatMoney(viewing.totalMinor, currency)}</dd></div>
                {viewing.payments.map((payment, index) => (
                  <div key={index} className="flex justify-between text-muted-foreground">
                    <dt className="capitalize">{payment.method}</dt>
                    <dd className="tabular">{formatMoney(payment.amountMinor, currency)}</dd>
                  </div>
                ))}
                {viewing.changeMinor > 0 && (
                  <div className="flex justify-between text-muted-foreground"><dt>Change</dt><dd className="tabular">{formatMoney(viewing.changeMinor, currency)}</dd></div>
                )}
                {viewing.status === 'cancelled' && <p className="pt-2 text-destructive">Cancelled: {viewing.cancelReason}</p>}
              </dl>
              {(viewing.tickets?.length ?? 0) > 0 && (
                <div className="space-y-1 border-t pt-3 text-sm">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Kitchen tickets</p>
                  {viewing.tickets!.map((ticket) => (
                    <div key={ticket._id} className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs">{ticket.ticketNumber}</span>
                      <span className="text-xs capitalize text-muted-foreground">{ticket.status}</span>
                      <Button variant="ghost" size="sm" onClick={() => setTicketToPrint({ orderId: viewing._id, ticketId: ticket._id })}>
                        <Printer />
                        Reprint
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {viewing.returnedTotalMinor ? (
                <p className="border-t pt-3 text-sm text-warning">
                  Refunded so far: <span className="tabular font-semibold">{formatMoney(viewing.returnedTotalMinor, currency)}</span>
                  {viewing.fullyReturned ? ' · fully refunded' : ''}
                </p>
              ) : null}
              <div className="flex flex-col gap-2">
                {viewing.status !== 'cancelled' && (
                  <Button className="w-full" variant="outline" onClick={() => setReceiptFor(viewing._id)}>
                    <Printer />
                    {viewing.status === 'paid' ? 'Print receipt' : 'Print bill'}
                  </Button>
                )}
                {viewing.status === 'paid' && !viewing.fullyReturned && (
                  <PermissionGate anyOf={['returns.create']}>
                    <Button className="w-full" variant="outline" onClick={() => setRefunding(viewing)}>
                      <Undo2 />
                      Refund items
                    </Button>
                  </PermissionGate>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {refunding && (
        <PosReturnDialog
          saleNumber={refunding.orderNumber}
          currency={currency}
          posConfig={posConfig}
          // A kitchen keeps no stock, so nothing is put back - only money moves.
          restockable={false}
          lines={refunding.items
            .filter((line) => !line.voidedAt && line.quantity > 0)
            .map((line) => ({
              _id: line._id,
              label: line.nameSnapshot,
              quantity: line.quantity,
              returnedQuantity: line.returnedQuantity,
              unitPriceMinor: line.unitPriceMinor,
            }))}
          onSubmit={(input) =>
            restaurantApi.createReturn(refunding._id, {
              items: input.items.map(({ saleItemId, quantity }) => ({ saleItemId, quantity })),
              reason: input.reason,
              refundMethod: input.refundMethod,
            })
          }
          onClose={() => {
            setRefunding(null);
            setViewing(null);
          }}
          invalidate={['restaurant']}
        />
      )}

      <RestaurantReceiptDialog orderId={receiptFor} onClose={() => setReceiptFor(null)} />
      <KitchenTicketDialog target={ticketToPrint} onClose={() => setTicketToPrint(null)} />
    </div>
  );
}
