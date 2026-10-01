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
import { LoyaltyCardDialog } from '@/features/loyalty/LoyaltyCardDialog';
import { LoyaltyStrip } from '@/features/loyalty/LoyaltyStrip';
import { maxRedeemablePoints, pointsForSpend } from '@/features/loyalty/loyaltyMath';
import { useLoyaltyAccess } from '@/features/loyalty/useLoyaltyAccess';
import { CategoryFilter } from '@/features/catalogue/CategoryFilter';
import { MenuItemPicker, needsChoosing, type PickedMenuItem } from '@/features/restaurant/MenuItemPicker';
import { loyaltyApi, storeApi } from '@/api/endpoints';
import { restaurantApi, type OrderLineBody } from '@/api/restaurant';
import { restaurantCategoriesApi } from '@/api/posCategories';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import type { MenuItem, RestaurantOrder } from '@/types/restaurant';
import { tendersFromConfig, type LoyaltyLookup } from '@/types/domain';

/** An order not yet sent: prices shown are previews; the server prices on send. */
interface Draft {
  type: 'dine_in' | 'takeaway';
  tableId?: string;
  tableName?: string;
  /** Whose order this is. Chosen before it is sent - see the panel below. */
  customer?: SelectedCustomer | null;
  lines: DraftLine[];
}

interface DraftLine {
  /** Identifies the LINE, not the dish: one dish may appear at two sizes. */
  key: string;
  menuItemId: string;
  name: string;
  variantId?: string;
  variantName: string;
  addOnOptionIds: string[];
  addOnNames: string[];
  /** A preview only. The server prices the line again when the order is sent. */
  priceMinor: number;
  quantity: number;
}

/** Two lines are the same line only if the dish, the size and the extras match. */
const lineKey = (menuItemId: string, variantId: string | undefined, addOnOptionIds: string[]) =>
  [menuItemId, variantId ?? '', [...addOnOptionIds].sort().join('+')].join('|');

/** How a chosen line reads under the dish name: "10 inch · Extra cheese". */
const lineDetail = (variantName: string, addOnNames: string[]) => [variantName, ...addOnNames].filter(Boolean).join(' · ');

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
  const [category, setCategory] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [cancelling, setCancelling] = React.useState(false);
  const [choosing, setChoosing] = React.useState<MenuItem | null>(null);
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
        items: current.lines.map((line) => ({
          menuItemId: line.menuItemId,
          ...(line.variantId ? { variantId: line.variantId } : {}),
          ...(line.addOnOptionIds.length > 0 ? { addOnOptionIds: line.addOnOptionIds } : {}),
          quantity: line.quantity,
        })),
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
    mutationFn: ({ id, line }: { id: string; line: OrderLineBody }) => restaurantApi.addItems(id, [line]),
    onSuccess: showOrder,
    onError: (err) => toast.error(errorMessage(err, 'Could not add the item')),
  });

  const changeLine = useMutation({
    mutationFn: ({ id, lineId, quantity }: { id: string; lineId: string; quantity: number }) =>
      quantity > 0 ? restaurantApi.updateLine(id, lineId, quantity) : restaurantApi.removeLine(id, lineId),
    onSuccess: showOrder,
    onError: (err) => toast.error(errorMessage(err, 'Could not change the line')),
  });

  // The sections the kitchen offers, in the order the owner put them, and
  // without the ones they hid - the same list the Menu sections screen manages.
  const { data: sections } = useQuery({ queryKey: ['restaurant', 'categories', 'filter'], queryFn: () => restaurantCategoriesApi.list() });
  const categories = React.useMemo(() => (sections ?? []).map((row) => row.name), [sections]);
  const visibleMenu = (menu?.items ?? []).filter(
    (item) =>
      (category === 'all' || item.category === category) &&
      (!search.trim() || item.name.toLowerCase().includes(search.trim().toLowerCase())),
  );

  /** A dish with sizes or extras is asked about first; a plain one goes straight on. */
  const pickMenuItem = (item: MenuItem) => {
    if (!order?.status && !draft) {
      toast.info('Choose a table or start a takeaway first');
      return;
    }
    if (needsChoosing(item)) {
      setChoosing(item);
      return;
    }
    addChosen(item, { variantName: '', addOnOptionIds: [], addOnNames: [], unitPriceMinor: item.priceMinor });
  };

  const addChosen = (item: MenuItem, picked: PickedMenuItem) => {
    if (order && order.status === 'open') {
      addToOrder.mutate({
        id: order._id,
        line: {
          menuItemId: item._id,
          ...(picked.variantId ? { variantId: picked.variantId } : {}),
          ...(picked.addOnOptionIds.length > 0 ? { addOnOptionIds: picked.addOnOptionIds } : {}),
          quantity: 1,
        },
      });
      return;
    }
    if (!draft) return;
    const key = lineKey(item._id, picked.variantId, picked.addOnOptionIds);
    const existing = draft.lines.find((line) => line.key === key);
    setDraft({
      ...draft,
      lines: existing
        ? draft.lines.map((line) => (line.key === key ? { ...line, quantity: line.quantity + 1 } : line))
        : [
            ...draft.lines,
            {
              key,
              menuItemId: item._id,
              name: item.name,
              variantId: picked.variantId,
              variantName: picked.variantName,
              addOnOptionIds: picked.addOnOptionIds,
              addOnNames: picked.addOnNames,
              priceMinor: picked.unitPriceMinor,
              quantity: 1,
            },
          ],
    });
  };

  const activeOrder = order && order._id === orderId ? order : null;
  const pendingKitchen = activeOrder ? unsentChanges(activeOrder) : 0;

  return (
    <div className="flex min-h-full flex-col gap-4 p-4 lg:grid lg:h-full lg:grid-cols-[16rem_1fr_24rem] lg:p-6">
      {/* ---------------------------------------------------- floor */}
      <Card className="flex flex-col lg:min-h-0">
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
      <Card className="flex flex-col lg:min-h-0">
        <CardHeader className="space-y-3 pb-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search dishes…" />
          <CategoryFilter categories={categories} value={category} onChange={setCategory} className="pb-1" />
        </CardHeader>
        <CardContent className="scrollbar-thin max-h-[55vh] min-h-0 flex-1 overflow-y-auto lg:max-h-none">
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
      {/*
        Three sections, and only ONE of them scrolls.

        The cart takes whatever room is left and scrolls inside it, so a long
        order never pushes anything off the card. The billing section below it is
        pinned at its natural height and never scrolls: a cashier taking money is
        never hunting for a tender row or a Complete button that has slid out of
        sight. This is the same shape the Super Shop till uses.
      */}
      <Card className="flex flex-col lg:min-h-0">
        <CardHeader className="shrink-0 flex-row items-center justify-between space-y-0 pb-2">
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

        <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          {/*
            The one scroll. Capped on a phone, where the card has no column
            height to fill, so the billing section below is never pushed off the
            bottom of an order with twenty lines on it.
          */}
          <div className="scrollbar-thin max-h-[38vh] min-h-[4rem] flex-1 overflow-y-auto px-4 lg:max-h-none lg:min-h-[5rem]">
          {!activeOrder && !draft && <EmptyState title="Pick a table" description="Or start a takeaway, then tap dishes to add them." />}

          {draft && (
            <ul className="divide-y">
              {draft.lines.map((line) => (
                <li key={line.key} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block truncate">{line.name}</span>
                    {lineDetail(line.variantName, line.addOnNames) && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {lineDetail(line.variantName, line.addOnNames)}
                      </span>
                    )}
                  </span>
                  <QuantityStepper
                    quantity={line.quantity}
                    onChange={(quantity) =>
                      setDraft({
                        ...draft,
                        lines: quantity > 0
                          ? draft.lines.map((l) => (l.key === line.key ? { ...l, quantity } : l))
                          : draft.lines.filter((l) => l.key !== line.key),
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
                    <span className={cn('min-w-0 flex-1 text-sm', voided && 'text-muted-foreground line-through')}>
                      <span className="block truncate">{line.nameSnapshot}</span>
                      {lineDetail(line.variantNameSnapshot ?? '', (line.addOns ?? []).map((addOn) => addOn.nameSnapshot)) && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {lineDetail(line.variantNameSnapshot ?? '', (line.addOns ?? []).map((addOn) => addOn.nameSnapshot))}
                        </span>
                      )}
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
          </div>

          {/* ------------------------------------------- not sent yet */}
          {draft && (
            <div className="shrink-0 space-y-3 border-t p-4">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-muted-foreground">Estimated total</span>
                <span className="tabular text-2xl font-bold">
                  {formatMoney(draft.lines.reduce((sum, line) => sum + line.priceMinor * line.quantity, 0), currency)}
                </span>
              </div>
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
            </div>
          )}

          {/* ------------------------------------------- billing, always on show */}
          {activeOrder?.status === 'open' && (
            <BillingPanel
              // Remounting on the order keeps a discount typed for table 4 from
              // following the cashier to table 7.
              key={activeOrder._id}
              order={activeOrder}
              currency={currency}
              allowDiscount={can('sales.discount')}
              canCancel={can('sales.cancel')}
              pendingKitchen={pendingKitchen}
              sendingChanges={sendChanges.isPending}
              onSendChanges={() => sendChanges.mutate(activeOrder)}
              onCancel={() => setCancelling(true)}
              onPrintBill={() => {
                setAutoPrintReceipt(false);
                setReceiptFor(activeOrder._id);
              }}
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

          {/* ------------------------------------------- settled or cancelled */}
          {activeOrder && activeOrder.status !== 'open' && (
            <div className="shrink-0 space-y-3 border-t p-4">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-muted-foreground">Total</span>
                <span className="tabular text-2xl font-bold">{formatMoney(activeOrder.totalMinor, currency)}</span>
              </div>
              <Badge variant={activeOrder.status === 'paid' ? 'success' : 'secondary'} className="w-full justify-center py-1.5">
                {activeOrder.status === 'paid' ? 'Paid' : 'Cancelled'}
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>

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

      <MenuItemPicker
        item={choosing}
        currency={currency}
        onClose={() => setChoosing(null)}
        onPick={(picked) => {
          if (choosing) addChosen(choosing, picked);
          setChoosing(null);
        }}
      />

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

/**
 * The billing section, pinned under the cart and always on show.
 *
 * Everything a bill needs in one place: the customer the order belongs to, a
 * discount, a loyalty card, the tenders (split included), what is still due or
 * owed back in change, and Complete sale. It is laid out at its natural height
 * and never scrolls - the cart above it is the only thing that does - so the
 * cashier can always see the money.
 *
 * The parent remounts this per order, which is what resets a typed discount or
 * a scanned card between one table and the next. Every amount is recomputed by
 * the server on payment; nothing here is trusted.
 */
function BillingPanel({
  order,
  currency,
  allowDiscount,
  canCancel,
  pendingKitchen,
  sendingChanges,
  onSendChanges,
  onCancel,
  onPrintBill,
  onPaid,
}: {
  order: RestaurantOrder;
  currency: string;
  allowDiscount: boolean;
  canCancel: boolean;
  pendingKitchen: number;
  sendingChanges: boolean;
  onSendChanges: () => void;
  onCancel: () => void;
  onPrintBill: () => void;
  onPaid: (order: RestaurantOrder) => void;
}) {
  const [discountMinor, setDiscountMinor] = React.useState<number | null>(0);
  // A restaurant earns on the BILL, so the card is scanned when it is settled.
  // Only a scanned card earns or redeems - never the customer on the order.
  const [loyaltyMember, setLoyaltyMember] = React.useState<LoyaltyLookup | null>(null);
  const [redeemPoints, setRedeemPoints] = React.useState<number | null>(null);
  const [cardDialogOpen, setCardDialogOpen] = React.useState(false);
  const loyaltyAccess = useLoyaltyAccess();

  const payableMinor = Math.max(0, order.subtotalMinor - (discountMinor ?? 0));
  const maxRedeemable = loyaltyMember ? maxRedeemablePoints(payableMinor, loyaltyMember.pointValueMinor, loyaltyMember.pointsBalance) : 0;
  const redeeming = Math.min(redeemPoints ?? 0, maxRedeemable);
  const loyaltyDiscountMinor = loyaltyMember ? redeeming * loyaltyMember.pointValueMinor : 0;
  const total = payableMinor - loyaltyDiscountMinor;

  // The branch decides which tenders it takes; the till only offers those.
  const { data: posConfig } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });
  const loyaltyAvailable = loyaltyAccess.inPlan && posConfig?.loyalty?.available === true;
  const pointsToEarn = loyaltyMember ? pointsForSpend(total, loyaltyMember.earnSpendMinor) : 0;
  const availableMethods = tendersFromConfig(posConfig);
  // The same payment maths as every other till: cash is what the guest hands
  // over, and change comes out of it. Untouched cash follows what is due, so
  // adding a dish mid-payment simply moves the figure.
  const payments = usePayments(total);

  const attachCard = async (code: string): Promise<boolean> => {
    if (!loyaltyAvailable) return false;
    try {
      const member = await loyaltyApi.lookup(code);
      if (member.status !== 'active') {
        toast.error('Loyalty card is inactive', { description: `${member.cardNumber} cannot earn or redeem points.` });
        return true;
      }
      setLoyaltyMember(member);
      setRedeemPoints(null);
      toast.success(`Loyalty member: ${member.customer?.name ?? member.cardNumber}`, { description: `${member.pointsBalance} points` });
      setCardDialogOpen(false);
      return true;
    } catch (error) {
      toast.error(errorMessage(error, 'Could not look up that card'));
      return true;
    }
  };

  // A second click before React has re-rendered the disabled button would send
  // a second payment. The server refuses it (the revision has moved on), but
  // the cashier should not see a failure for a sale that went through.
  const inFlight = React.useRef(false);

  const pay = useMutation({
    mutationFn: () =>
      restaurantApi.pay(order._id, {
        // Cash carries what was handed over; the excess is the change.
        payments: tenderedRows(payments),
        discountMinor: discountMinor ?? 0,
        // The revision the cashier is looking at; a dish added meanwhile is refused.
        rev: order.rev,
        // The card is what earns and redeems; the server re-checks both.
        ...(loyaltyMember ? { loyaltyMembershipId: loyaltyMember.id, redeemPoints: redeeming } : {}),
      }),
    onSuccess: onPaid,
    onError: (err) => toast.error(errorMessage(err, 'Payment failed')),
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const completeSale = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    pay.mutate();
  };

  const discountTooBig = (discountMinor ?? 0) > order.subtotalMinor;
  const nothingToCharge = order.items.every((line) => line.quantity === 0);
  const valid = payments.isSettled && !discountTooBig && !nothingToCharge;

  return (
    <>
      <div className="shrink-0 space-y-1.5 border-t px-4 py-2">
        {order.customerNameSnapshot && (
          <p className="flex items-center gap-1.5 text-sm">
            <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{order.customerNameSnapshot}</span>
          </p>
        )}

        <dl className="space-y-0.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="tabular">{formatMoney(order.subtotalMinor, currency)}</dd>
          </div>
          {allowDiscount && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">Discount</dt>
              <dd>
                <MoneyInput optional value={discountMinor} onChange={setDiscountMinor} className="w-28 [&_input]:h-8" ariaLabel="Discount" />
              </dd>
            </div>
          )}
          {loyaltyDiscountMinor > 0 && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Points</dt>
              <dd className="tabular text-success">− {formatMoney(loyaltyDiscountMinor, currency)}</dd>
            </div>
          )}
          <div className="flex items-baseline justify-between border-t pt-1">
            <dt className="font-semibold">To pay</dt>
            <dd className="tabular text-2xl font-bold">{formatMoney(total, currency)}</dd>
          </div>
        </dl>

        {discountTooBig && <p className="text-xs text-destructive">A discount cannot be more than the order.</p>}

        {loyaltyAvailable && !loyaltyMember && (
          <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setCardDialogOpen(true)}>
            <CreditCard />
            Loyalty card
          </Button>
        )}
        {loyaltyMember && (
          <LoyaltyStrip
            member={loyaltyMember}
            currency={currency}
            canRedeem={loyaltyAccess.canRedeem}
            redeemPoints={redeemPoints}
            maxRedeemable={maxRedeemable}
            pointsToEarn={pointsToEarn}
            onRedeemChange={setRedeemPoints}
            onRemove={() => {
              setLoyaltyMember(null);
              setRedeemPoints(null);
            }}
          />
        )}

        <PaymentPanel
          compact
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

        {pendingKitchen > 0 && (
          <Button variant="secondary" size="sm" className="w-full" loading={sendingChanges} onClick={onSendChanges}>
            <ChefHat />
            Send {pendingKitchen} change{pendingKitchen === 1 ? '' : 's'} to kitchen
          </Button>
        )}
      </div>

      {/* Pinned: the cashier never scrolls to find Complete sale. */}
      <div className="flex shrink-0 gap-2 border-t p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] lg:pb-2.5">
        {canCancel && (
          <Button variant="outline" size="lg" onClick={onCancel} aria-label="Cancel order">
            <Trash2 />
          </Button>
        )}
        <Button variant="outline" size="lg" onClick={onPrintBill} aria-label="Print bill">
          <Printer />
        </Button>
        <Button className="flex-1" size="lg" disabled={!valid} loading={pay.isPending} onClick={completeSale}>
          <CreditCard />
          Complete sale
        </Button>
      </div>

      <LoyaltyCardDialog open={cardDialogOpen} onOpenChange={setCardDialogOpen} onSubmit={(code) => attachCard(code)} />
    </>
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
