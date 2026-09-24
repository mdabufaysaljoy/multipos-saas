import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Armchair, ChefHat, CreditCard, Minus, Plus, Printer, ShoppingBag, Trash2, UserRound, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState, LoadingState } from '@/components/states';
import { MoneyInput } from '@/components/MoneyInput';
import { LimitAlert } from '@/components/LimitAlert';
import { KitchenTicketDialog, RestaurantReceiptDialog } from '@/features/restaurant/RestaurantPrints';
import { ApiError } from '@/api/client';
import { CustomerPicker, saleCustomerFields, type SelectedCustomer } from '@/features/customers/CustomerPicker';
import { PaymentPanel } from '@/features/payments/PaymentPanel';
import { tenderedRows } from '@/features/payments/paymentMath';
import { usePayments } from '@/features/payments/usePayments';
import { storeApi } from '@/api/endpoints';
import { restaurantApi } from '@/api/restaurant';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import type { PaymentMethod } from '@/types/domain';
import type { MenuItem, RestaurantOrder } from '@/types/restaurant';

/** An order not yet sent: prices shown are previews; the server prices on send. */
interface Draft {
  type: 'dine_in' | 'takeaway';
  tableId?: string;
  tableName?: string;
  /** Whose order this is. Chosen before it is sent - see the panel below. */
  customer?: SelectedCustomer | null;
  lines: { menuItemId: string; name: string; priceMinor: number; quantity: number }[];
}

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Lines whose quantity differs from what the kitchen already has. */
const unsentChanges = (order: RestaurantOrder) =>
  order.items.filter((line) => line.quantity !== (line.sentQuantity ?? 0)).length;

/**
 * Restaurant point of sale: pick a table or start a takeaway, add dishes, send
 * the order (which also sends a kitchen ticket), then take payment and print
 * the receipt. Every amount charged is computed by the server.
 */
export function RestaurantPosPage() {
  const { activeStore, can } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const queryClient = useQueryClient();

  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [orderId, setOrderId] = React.useState<string | null>(null);
  const [category, setCategory] = React.useState('All');
  const [search, setSearch] = React.useState('');
  const [paying, setPaying] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [ticketToPrint, setTicketToPrint] = React.useState<{ orderId: string; ticketId: string } | null>(null);
  const [receiptFor, setReceiptFor] = React.useState<string | null>(null);
  // A bill is asked for; a receipt follows a payment and prints itself.
  const [autoPrintReceipt, setAutoPrintReceipt] = React.useState(false);

  const { data: tables } = useQuery({ queryKey: ['restaurant', 'tables'], queryFn: restaurantApi.tables });
  const { data: currentShift, isSuccess: shiftChecked } = useQuery({
    queryKey: ['restaurant', 'shift', 'current'],
    queryFn: restaurantApi.currentShift,
  });
  const { data: menu, isLoading: menuLoading } = useQuery({
    queryKey: ['restaurant', 'menu', 'pos'],
    queryFn: () => restaurantApi.menu({ limit: 100, availableOnly: 'true' }),
  });
  const { data: takeaways } = useQuery({
    queryKey: ['restaurant', 'orders', 'open-takeaway'],
    queryFn: () => restaurantApi.orders({ status: 'open', type: 'takeaway', limit: 50 }),
  });
  const { data: order } = useQuery({
    queryKey: ['restaurant', 'order', orderId],
    queryFn: () => restaurantApi.order(orderId!),
    enabled: Boolean(orderId),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['restaurant'] });
  const showOrder = (next: RestaurantOrder) => {
    queryClient.setQueryData(['restaurant', 'order', next._id], next);
    setOrderId(next._id);
    setDraft(null);
    refresh();
  };
  const clear = () => {
    setOrderId(null);
    setDraft(null);
  };
  /** Shows the order and offers the newest kitchen ticket for printing. */
  const showSent = (sent: RestaurantOrder) => {
    showOrder(sent);
    const latest = sent.tickets?.[sent.tickets.length - 1];
    if (latest) {
      toast.success(`${latest.ticketNumber} sent to the kitchen`);
      setTicketToPrint({ orderId: sent._id, ticketId: latest._id });
    }
  };

  // Opening an order sends its first kitchen ticket straight away.
  const send = useMutation({
    mutationFn: async (current: Draft) => {
      const created = await restaurantApi.createOrder({
        type: current.type,
        ...(current.tableId ? { tableId: current.tableId } : {}),
        ...saleCustomerFields(current.customer ?? null),
        items: current.lines.map((line) => ({ menuItemId: line.menuItemId, quantity: line.quantity })),
      });
      try {
        return await restaurantApi.sendToKitchen(created._id, created.rev);
      } catch (error) {
        // The order exists; only the ticket failed. Show it so it can be resent.
        showOrder(created);
        throw error;
      }
    },
    onSuccess: showSent,
    onError: (err) => toast.error(errorMessage(err, 'Could not send the order')),
  });

  const sendChanges = useMutation({
    mutationFn: (current: RestaurantOrder) => restaurantApi.sendToKitchen(current._id, current.rev),
    onSuccess: showSent,
    onError: (err) => {
      toast.error(errorMessage(err, 'Could not send to the kitchen'));
      refresh();
    },
  });

  const addToOrder = useMutation({
    mutationFn: ({ id, menuItemId }: { id: string; menuItemId: string }) => restaurantApi.addItems(id, [{ menuItemId, quantity: 1 }]),
    onSuccess: showOrder,
    onError: (err) => toast.error(errorMessage(err, 'Could not add the item')),
  });

  const changeLine = useMutation({
    mutationFn: ({ id, lineId, quantity }: { id: string; lineId: string; quantity: number }) =>
      quantity > 0 ? restaurantApi.updateLine(id, lineId, quantity) : restaurantApi.removeLine(id, lineId),
    onSuccess: showOrder,
    onError: (err) => toast.error(errorMessage(err, 'Could not change the line')),
  });

  const categories = React.useMemo(() => ['All', ...new Set((menu?.items ?? []).map((item) => item.category))], [menu]);
  const visibleMenu = (menu?.items ?? []).filter(
    (item) =>
      (category === 'All' || item.category === category) &&
      (!search.trim() || item.name.toLowerCase().includes(search.trim().toLowerCase())),
  );

  const pickMenuItem = (item: MenuItem) => {
    if (order && order.status === 'open') {
      addToOrder.mutate({ id: order._id, menuItemId: item._id });
      return;
    }
    if (!draft) {
      toast.info('Choose a table or start a takeaway first');
      return;
    }
    const existing = draft.lines.find((line) => line.menuItemId === item._id);
    setDraft({
      ...draft,
      lines: existing
        ? draft.lines.map((line) => (line.menuItemId === item._id ? { ...line, quantity: line.quantity + 1 } : line))
        : [...draft.lines, { menuItemId: item._id, name: item.name, priceMinor: item.priceMinor, quantity: 1 }],
    });
  };

  const activeOrder = order && order._id === orderId ? order : null;
  const pendingKitchen = activeOrder ? unsentChanges(activeOrder) : 0;

  return (
    <div className="grid h-full gap-4 p-4 lg:grid-cols-[16rem_1fr_22rem] lg:p-6">
      {/* ---------------------------------------------------- floor */}
      <Card className="flex min-h-0 flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Floor</CardTitle>
        </CardHeader>
        <CardContent className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto">
          <LimitAlert resource="monthlySales" />
          {shiftChecked && !currentShift && (
            <Link to="/shifts" className="block rounded-md border border-warning/50 bg-warning/10 px-2 py-1.5 text-xs">
              No shift is open. Payments will not be counted against a cash drawer. <span className="font-medium underline">Open a shift</span>
            </Link>
          )}
          <Button variant="outline" className="w-full" onClick={() => { setOrderId(null); setDraft({ type: 'takeaway', lines: [] }); }}>
            <ShoppingBag />
            New takeaway
          </Button>

          <div className="grid grid-cols-3 gap-2 lg:grid-cols-2">
            {(tables ?? [])
              .filter((table) => table.isActive)
              .map((table) => {
                const occupied = Boolean(table.openOrderId);
                const selected = draft?.tableId === table._id || activeOrder?.tableId === table._id;
                return (
                  <button
                    key={table._id}
                    type="button"
                    onClick={() => {
                      if (occupied) {
                        setDraft(null);
                        setOrderId(table.openOrderId);
                      } else {
                        setOrderId(null);
                        setDraft({ type: 'dine_in', tableId: table._id, tableName: table.name, lines: [] });
                      }
                    }}
                    className={cn(
                      'rounded-md border p-2 text-left text-sm transition-colors',
                      occupied ? 'border-warning/50 bg-warning/10' : 'hover:bg-accent',
                      selected && 'ring-2 ring-primary',
                    )}
                  >
                    <span className="flex items-center gap-1 font-semibold">
                      <Armchair className="h-3.5 w-3.5" />
                      {table.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {occupied ? formatMoney(table.openOrderTotalMinor ?? 0, currency) : `${table.seats} seats`}
                    </span>
                  </button>
                );
              })}
          </div>
          {(tables?.length ?? 0) === 0 && <p className="text-xs text-muted-foreground">Add tables on the Tables page to take dine-in orders.</p>}

          {(takeaways?.items.length ?? 0) > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Open takeaways</p>
              {takeaways!.items.map((takeaway) => (
                <button
                  key={takeaway._id}
                  type="button"
                  onClick={() => { setDraft(null); setOrderId(takeaway._id); }}
                  className={cn('flex w-full justify-between rounded-md border p-2 text-sm hover:bg-accent', orderId === takeaway._id && 'ring-2 ring-primary')}
                >
                  <span className="font-mono text-xs">{takeaway.orderNumber}</span>
                  <span className="tabular text-xs">{formatMoney(takeaway.totalMinor, currency)}</span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------- menu */}
      <Card className="flex min-h-0 flex-col">
        <CardHeader className="space-y-3 pb-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search dishes…" />
          <div className="scrollbar-thin flex gap-1.5 overflow-x-auto pb-1">
            {categories.map((name) => (
              <Button key={name} size="sm" variant={category === name ? 'default' : 'outline'} className="shrink-0" onClick={() => setCategory(name)}>
                {name}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          {menuLoading && <LoadingState label="Loading the menu…" />}
          {!menuLoading && visibleMenu.length === 0 && <EmptyState title="Nothing to show" description="Add dishes on the Menu page." />}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {visibleMenu.map((item) => (
              <button
                key={item._id}
                type="button"
                onClick={() => pickMenuItem(item)}
                disabled={addToOrder.isPending}
                className="rounded-md border p-3 text-left transition-colors hover:bg-accent disabled:opacity-60"
              >
                <span className="block text-sm font-medium leading-tight">{item.name}</span>
                <span className="tabular mt-1 block text-sm text-muted-foreground">{formatMoney(item.priceMinor, currency)}</span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------- order */}
      <Card className="flex min-h-0 flex-col">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-base">
            {activeOrder
              ? `${activeOrder.orderNumber} · ${activeOrder.type === 'takeaway' ? 'Takeaway' : `Table ${activeOrder.tableNameSnapshot}`}`
              : draft
                ? draft.type === 'takeaway' ? 'New takeaway' : `Table ${draft.tableName}`
                : 'No order selected'}
          </CardTitle>
          {(activeOrder || draft) && (
            <Button variant="ghost" size="icon-sm" onClick={clear} aria-label="Close order">
              <X />
            </Button>
          )}
        </CardHeader>

        <CardContent className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          {!activeOrder && !draft && <EmptyState title="Pick a table" description="Or start a takeaway, then tap dishes to add them." />}

          {draft && (
            <ul className="divide-y">
              {draft.lines.map((line) => (
                <li key={line.menuItemId} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{line.name}</span>
                  <QuantityStepper
                    quantity={line.quantity}
                    onChange={(quantity) =>
                      setDraft({
                        ...draft,
                        lines: quantity > 0
                          ? draft.lines.map((l) => (l.menuItemId === line.menuItemId ? { ...l, quantity } : l))
                          : draft.lines.filter((l) => l.menuItemId !== line.menuItemId),
                      })
                    }
                  />
                  <span className="tabular w-20 text-right text-sm">{formatMoney(line.priceMinor * line.quantity, currency)}</span>
                </li>
              ))}
              {draft.lines.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Tap dishes to add them</p>}
            </ul>
          )}

          {activeOrder && (
            <ul className="divide-y">
              {activeOrder.items.map((line) => {
                const voided = Boolean(line.voidedAt);
                const unsent = !voided && line.quantity > (line.sentQuantity ?? 0);
                return (
                  <li key={line._id} className="flex items-center gap-2 py-2">
                    <span className={cn('min-w-0 flex-1 truncate text-sm', voided && 'text-muted-foreground line-through')}>
                      {line.nameSnapshot}
                    </span>
                    {voided && <Badge variant="secondary">Void</Badge>}
                    {unsent && activeOrder.status === 'open' && <Badge variant="warning">New</Badge>}
                    {!voided && activeOrder.status === 'open' && can('sales.create') ? (
                      <QuantityStepper
                        quantity={line.quantity}
                        disabled={changeLine.isPending}
                        onChange={(quantity) => changeLine.mutate({ id: activeOrder._id, lineId: line._id, quantity })}
                      />
                    ) : (
                      !voided && <span className="text-sm">× {line.quantity}</span>
                    )}
                    <span className="tabular w-20 text-right text-sm">{formatMoney(line.lineTotalMinor, currency)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>

        {(draft || activeOrder) && (
          <div className="space-y-3 border-t p-4">
            {activeOrder?.customerNameSnapshot && (
              <p className="flex items-center gap-1.5 text-sm">
                <UserRound className="h-4 w-4 text-muted-foreground" />
                <span className="truncate font-medium">{activeOrder.customerNameSnapshot}</span>
              </p>
            )}

            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">{draft ? 'Estimated total' : 'Total'}</span>
              <span className="tabular text-2xl font-bold">
                {formatMoney(
                  draft ? draft.lines.reduce((sum, line) => sum + line.priceMinor * line.quantity, 0) : activeOrder!.totalMinor,
                  currency,
                )}
              </span>
            </div>

            {draft && (
              <>
                {/* A restaurant customer belongs to the order: chosen now, and
                    fixed once the kitchen has it. */}
                <CustomerPicker
                  value={draft.customer ?? null}
                  onChange={(customer) => setDraft({ ...draft, customer })}
                  canCreate={can('customers.create')}
                />
                <Button className="w-full" size="lg" disabled={draft.lines.length === 0} loading={send.isPending} onClick={() => send.mutate(draft)}>
                  <ChefHat />
                  Send order
                </Button>
              </>
            )}

            {activeOrder?.status === 'open' && (
              <>
                {pendingKitchen > 0 && can('sales.create') && (
                  <Button variant="secondary" className="w-full" loading={sendChanges.isPending} onClick={() => sendChanges.mutate(activeOrder)}>
                    <ChefHat />
                    Send {pendingKitchen} change{pendingKitchen === 1 ? '' : 's'} to kitchen
                  </Button>
                )}
                <div className="grid grid-cols-[auto_auto_1fr] gap-2">
                  {can('sales.cancel') ? (
                    <Button variant="outline" size="lg" onClick={() => setCancelling(true)} aria-label="Cancel order">
                      <Trash2 />
                    </Button>
                  ) : (
                    <span />
                  )}
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={() => {
                      setAutoPrintReceipt(false);
                      setReceiptFor(activeOrder._id);
                    }}
                    aria-label="Print bill"
                  >
                    <Printer />
                  </Button>
                  <Button size="lg" disabled={activeOrder.items.every((line) => line.quantity === 0)} onClick={() => setPaying(true)}>
                    <CreditCard />
                    Take payment
                  </Button>
                </div>
              </>
            )}
            {activeOrder && activeOrder.status !== 'open' && (
              <Badge variant={activeOrder.status === 'paid' ? 'success' : 'secondary'} className="w-full justify-center py-1.5">
                {activeOrder.status === 'paid' ? 'Paid' : 'Cancelled'}
              </Badge>
            )}
          </div>
        )}
      </Card>

      {activeOrder && (
        <PayDialog
          open={paying}
          order={activeOrder}
          currency={currency}
          allowDiscount={can('sales.discount')}
          onOpenChange={setPaying}
          onPaid={(paid) => {
            toast.success(`Order ${paid.orderNumber} paid`, {
              description: paid.changeMinor > 0 ? `Give ${formatMoney(paid.changeMinor, currency)} change.` : undefined,
            });
            clear();
            refresh();
            // The receipt prints itself as soon as the order is settled.
            setAutoPrintReceipt(true);
            setReceiptFor(paid._id);
          }}
        />
      )}
      {activeOrder && (
        <CancelDialog
          open={cancelling}
          order={activeOrder}
          onOpenChange={setCancelling}
          onCancelled={() => {
            toast.success('Order cancelled', { description: 'Any tickets still in the kitchen were voided.' });
            clear();
            refresh();
          }}
        />
      )}

      <KitchenTicketDialog target={ticketToPrint} onClose={() => setTicketToPrint(null)} />
      <RestaurantReceiptDialog
        orderId={receiptFor}
        onClose={() => {
          setReceiptFor(null);
          setAutoPrintReceipt(false);
        }}
        autoPrint={autoPrintReceipt}
      />
    </div>
  );
}

function QuantityStepper({ quantity, onChange, disabled }: { quantity: number; onChange: (quantity: number) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="icon-sm" disabled={disabled} onClick={() => onChange(quantity - 1)} aria-label="One less">
        <Minus />
      </Button>
      <span className="tabular w-6 text-center text-sm">{quantity}</span>
      <Button variant="outline" size="icon-sm" disabled={disabled || quantity >= 999} onClick={() => onChange(quantity + 1)} aria-label="One more">
        <Plus />
      </Button>
    </div>
  );
}

function PayDialog({
  open,
  order,
  currency,
  allowDiscount,
  onOpenChange,
  onPaid,
}: {
  open: boolean;
  order: RestaurantOrder;
  currency: string;
  allowDiscount: boolean;
  onOpenChange: (open: boolean) => void;
  onPaid: (order: RestaurantOrder) => void;
}) {
  const [discountMinor, setDiscountMinor] = React.useState<number | null>(0);
  const total = Math.max(0, order.subtotalMinor - (discountMinor ?? 0));

  // The branch decides which tenders it takes; the till only offers those.
  const { data: posConfig } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });
  const availableMethods = (posConfig?.paymentMethods ?? ['cash']) as PaymentMethod[];
  // The same payment maths as every other till: cash is what the guest hands
  // over, and change comes out of it.
  const payments = usePayments(total);
  const { reset: resetPayments } = payments;

  React.useEffect(() => {
    if (open) {
      setDiscountMinor(0);
      resetPayments();
    }
  }, [open, order.totalMinor, resetPayments]);

  const pay = useMutation({
    mutationFn: () =>
      restaurantApi.pay(order._id, {
        // Cash carries what was handed over; the excess is the change.
        payments: tenderedRows(payments),
        discountMinor: discountMinor ?? 0,
        rev: order.rev,
      }),
    onSuccess: (paid) => {
      onOpenChange(false);
      onPaid(paid);
    },
    onError: (err) => toast.error(errorMessage(err, 'Payment failed')),
  });

  const valid = payments.isSettled && (discountMinor ?? 0) <= order.subtotalMinor;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Take payment</DialogTitle>
          <DialogDescription>{order.orderNumber}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-baseline justify-between rounded-md bg-muted/40 p-3">
            <span className="text-sm text-muted-foreground">To pay</span>
            <span className="tabular text-2xl font-bold">{formatMoney(total, currency)}</span>
          </div>
          {allowDiscount && (
            <div className="space-y-1.5">
              <Label>Discount</Label>
              <MoneyInput value={discountMinor} onChange={setDiscountMinor} ariaLabel="Discount" />
            </div>
          )}
          <PaymentPanel
            rows={payments.rows}
            availableMethods={availableMethods}
            totalMinor={total}
            hasCash={payments.hasCash}
            remainingPayableMinor={payments.remainingPayableMinor}
            changeMinor={payments.changeMinor}
            dueMinor={payments.dueMinor}
            cashTyped={payments.cashTyped}
            issues={payments.issues}
            currency={currency}
            onAmountChange={payments.setAmount}
            onMethodChange={payments.setMethod}
            onAddRow={payments.addRow}
            onRemoveRow={payments.removeRow}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Back
          </Button>
          <Button disabled={!valid} loading={pay.isPending} onClick={() => pay.mutate()}>
            Confirm payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({
  open,
  order,
  onOpenChange,
  onCancelled,
}: {
  open: boolean;
  order: RestaurantOrder;
  onOpenChange: (open: boolean) => void;
  onCancelled: () => void;
}) {
  const [reason, setReason] = React.useState('');
  React.useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const cancel = useMutation({
    mutationFn: () => restaurantApi.cancel(order._id, reason.trim()),
    onSuccess: () => {
      onOpenChange(false);
      onCancelled();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not cancel the order')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Cancel {order.orderNumber}?</DialogTitle>
          <DialogDescription>The table is freed, nothing is charged, and tickets still in the kitchen are voided.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="cancel-reason">Reason</Label>
          <Input id="cancel-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer left" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep order
          </Button>
          <Button variant="destructive" disabled={reason.trim().length < 3} loading={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
