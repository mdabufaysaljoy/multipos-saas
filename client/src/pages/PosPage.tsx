import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Banknote, ChevronDown, ChevronUp, CreditCard, Eraser, Gift, ShoppingCart } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyInput } from '@/components/MoneyInput';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LimitAlert } from '@/components/LimitAlert';
import { CartPanel } from '@/features/pos/CartPanel';
import { CustomerPicker, type SelectedCustomer } from '@/features/pos/CustomerPicker';
import { ProductSearchPanel } from '@/features/pos/ProductSearchPanel';
import { computeTotals, useCart, validateCart } from '@/features/pos/useCart';
import { PaymentPanel } from '@/features/pos/PaymentPanel';
import { VariantPickerDialog } from '@/features/pos/VariantPickerDialog';
import { useBarcodeScanner } from '@/features/pos/useBarcodeScanner';
import { ScanDialog } from '@/features/pos/ScanDialog';
import type { PosProductGroup } from '@/features/pos/groupVariants';
import { usePayments } from '@/features/pos/usePayments';
import { ReceiptDialog } from '@/features/receipt/ReceiptDialog';
import { ApiError } from '@/api/client';
import { loyaltyApi, productApi, saleApi, storeApi } from '@/api/endpoints';
import { LoyaltyCardDialog } from '@/features/loyalty/LoyaltyCardDialog';
import { LoyaltyStrip } from '@/features/loyalty/LoyaltyStrip';
import { isLoyaltyCardCode, maxRedeemablePoints, pointsForSpend } from '@/features/loyalty/loyaltyMath';
import { newRequestKey, useLoyaltyAccess } from '@/features/loyalty/useLoyaltyAccess';
import { useAuth } from '@/hooks/useAuth';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { LoyaltyLookup, PaymentMethod, PosVariant, Sale } from '@/types/domain';

export function PosPage() {
  const { can, activeStore } = useAuth();
  const queryClient = useQueryClient();
  const cart = useCart();

  const [customer, setCustomer] = React.useState<SelectedCustomer | null>(null);
  const [note, setNote] = React.useState('');
  const [receiptSaleId, setReceiptSaleId] = React.useState<string | null>(null);
  const [pickerGroup, setPickerGroup] = React.useState<PosProductGroup | null>(null);
  const [scanOpen, setScanOpen] = React.useState(false);
  // Mobile-only: the cart sheet. Desktop ignores it entirely.
  const [cartOpen, setCartOpen] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);
  // An out-of-stock variant waiting for the cashier to confirm "Sell anyway".
  const [outOfStockPending, setOutOfStockPending] = React.useState<PosVariant | null>(null);
  // Loyalty: only a scanned (or typed) CARD makes this a loyalty sale - never the customer or phone.
  const [loyaltyMember, setLoyaltyMember] = React.useState<LoyaltyLookup | null>(null);
  const [redeemPoints, setRedeemPoints] = React.useState<number | null>(null);
  const [cardDialogOpen, setCardDialogOpen] = React.useState(false);
  const [cardLookupPending, setCardLookupPending] = React.useState(false);
  // One key per checkout: a double submit or network retry returns the same sale.
  const checkoutKey = React.useRef(newRequestKey('sale'));
  const loyaltyAccess = useLoyaltyAccess();

  const canChangePrice = can('sales.changePrice');
  const canDiscount = can('sales.discount');
  const canAddCustomer = can('customers.create');
  // UX only. The server re-checks the permission (from the database) on every sale.
  const canSellOutOfStock = can('sales.sellOutOfStock');

  const { data: store } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });
  const currency = store?.currency ?? activeStore?.currency ?? 'BDT';

  const taxOnTop = Boolean(store?.tax.enabled && !store?.tax.inclusive);
  const loyaltyAvailable = loyaltyAccess.inPlan && store?.loyalty?.available === true;
  // Points can pay for the goods after the cart discount, never more, never more than the card holds.
  const baseTotals = computeTotals(cart.state, store?.tax.rateBasisPoints ?? 0, taxOnTop);
  const maxRedeemable = loyaltyMember
    ? maxRedeemablePoints(baseTotals.subtotalMinor - baseTotals.discountMinor, loyaltyMember.pointValueMinor, loyaltyMember.pointsBalance)
    : 0;
  const requestedPoints = loyaltyMember && loyaltyAccess.canRedeem ? (redeemPoints ?? 0) : 0;
  const redeemTooHigh = requestedPoints > maxRedeemable;
  const redeemingPoints = redeemTooHigh ? 0 : requestedPoints;
  const totals = computeTotals(
    cart.state,
    store?.tax.rateBasisPoints ?? 0,
    taxOnTop,
    loyaltyMember ? redeemingPoints * loyaltyMember.pointValueMinor : 0,
  );
  const pointsToEarn = loyaltyMember ? pointsForSpend(totals.subtotalMinor - totals.discountMinor - totals.loyaltyDiscountMinor, loyaltyMember.earnSpendMinor) : 0;
  const issues = validateCart(cart.state, { canSellOutOfStock });
  // The store's VAT switch decides what the summary shows; the receipt reads the same setting.
  const vatEnabled = Boolean(store?.tax.enabled);
  const cartReady = cart.state.lines.length > 0 && issues.length === 0;

  const availableMethods = (store?.paymentMethods ?? ['cash']) as PaymentMethod[];
  const payments = usePayments(cartReady ? totals.totalMinor : 0);

  // Both halves must be satisfied: a valid cart AND a payment allocation that covers the total.
  // Points covering the whole sale leave nothing to pay, so no payment is taken.
  const coveredByPoints = cartReady && totals.loyaltyDiscountMinor > 0 && totals.totalMinor === 0;
  const canCheckout = cartReady && !redeemTooHigh && (payments.isSettled || coveredByPoints);

  const checkout = useMutation({
    mutationFn: (): Promise<Sale> =>
      saleApi.create({
        items: cart.state.lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          // Only send a price when it actually differs, so a cashier without
          // the override permission never trips the server's check by accident.
          ...(line.unitPriceMinor !== line.listPriceMinor ? { unitPriceMinor: line.unitPriceMinor } : {}),
        })),
        ...(customer?.id ? { customerId: customer.id } : {}),
        ...(customer && !customer.id
          ? { customer: { name: customer.name, phone: customer.phone, email: customer.email || undefined } }
          : {}),
        discountType: cart.state.discountType,
        discountValue: cart.state.discountValue,
        // The amounts APPLIED to the sale (they add up to the total); cash
        // handed over beyond that travels separately and becomes change. The
        // server re-prices the sale and checks all of it.
        ...(coveredByPoints
          ? { paymentMethod: 'cash' }
          : {
              paymentMethod: payments.applied.slice().sort((a, b) => b.amountMinor - a.amountMinor)[0].method,
              payments: payments.applied.map((row) => ({ method: row.method, amountMinor: row.amountMinor, reference: '' })),
              ...(payments.hasCash && payments.cashTenderedMinor !== null ? { cashTenderedMinor: payments.cashTenderedMinor } : {}),
            }),
        // Which card and how many points - the server works out their value and what is earned.
        ...(loyaltyMember ? { loyaltyMembershipId: loyaltyMember.id } : {}),
        ...(loyaltyMember && redeemingPoints > 0 ? { redeemPoints: redeemingPoints } : {}),
        idempotencyKey: checkoutKey.current,
        note,
      }),
    onSuccess: (sale) => {
      toast.success(`Sale ${sale.saleNumber} completed`, {
        description: `${formatMoney(sale.totalMinor, currency)} · ${sale.items.length} line${sale.items.length === 1 ? '' : 's'}`,
      });
      // The server is the one that knows stock at the moment of sale, so say so when it sold below zero.
      const overridden = sale.items.filter((item) => item.outOfStockOverride);
      if (overridden.length > 0) {
        toast.warning('Includes an out-of-stock sale', {
          description: overridden.map((item) => `${item.productNameSnapshot} (${item.variantNameSnapshot})`).join(', '),
        });
      }
      if (sale.loyalty) {
        const parts = [
          sale.loyalty.pointsRedeemed > 0 ? `${sale.loyalty.pointsRedeemed} redeemed` : null,
          sale.loyalty.pointsEarned > 0 ? `${sale.loyalty.pointsEarned} earned` : null,
          `balance ${sale.loyalty.balanceAfter}`,
        ].filter(Boolean);
        toast.success('Loyalty points updated', { description: parts.join(' · ') });
      }
      setReceiptSaleId(sale._id);
      setCartOpen(false);
      resetSale();
      // Stock, sales and dashboard figures have all moved.
      void queryClient.invalidateQueries({ queryKey: ['pos-search'] });
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : 'Could not complete the sale';
      toast.error('Sale failed', { description: message });
      // The balance may have changed at another till: reload the card's figures.
      if (loyaltyMember) void attachCard(loyaltyMember.cardNumber, { quiet: true });
    },
  });

  /**
   * A product with exactly one sellable variant goes straight into the cart;
   * anything with real options prompts for the variant first.
   */
  const handleProductSelect = (group: PosProductGroup) => {
    const sellable = group.variants.filter((variant) => variant.stock > 0 || canSellOutOfStock);
    if (sellable.length === 1) {
      requestAdd(sellable[0]);
      return;
    }
    setPickerGroup(group);
  };

  /**
   * Every way into the cart (grid, variant picker, barcode) goes through here,
   * so the out-of-stock rule is the same for all of them. An out-of-stock
   * variant needs the permission and a one-time confirmation; adding more of a
   * line already confirmed does not ask again.
   */
  const requestAdd = (variant: PosVariant): boolean => {
    if (variant.stock > 0) {
      cart.addVariant(variant);
      return true;
    }
    if (!canSellOutOfStock) {
      toast.error('Out of stock', { description: `${variant.productName} (${variant.variantName})` });
      return false;
    }
    if (cart.state.lines.some((line) => line.variantId === variant.variantId && line.outOfStockSale)) {
      cart.addVariant(variant, 1, { allowOutOfStock: true });
      return true;
    }
    setOutOfStockPending(variant);
    return false;
  };
  const requestAddRef = React.useRef(requestAdd);
  requestAddRef.current = requestAdd;

  /**
   * Barcode resolution. Looks the code up server-side, then adds the matching
   * variant. `cart.addVariant` increments an existing line rather than creating
   * a duplicate row, so scanning the same item twice reads as quantity 2.
   */
  /**
   * Finds a member by card barcode or card number and attaches the card and its
   * customer to this sale. Creates nothing and awards nothing. Returns false
   * when no member has that code.
   */
  const attachCard = async (code: string, options: { quiet?: boolean } = {}): Promise<boolean> => {
    if (!loyaltyAvailable) return false;
    setCardLookupPending(true);
    try {
      const member = await loyaltyApi.lookup(code);
      if (member.status !== 'active') {
        toast.error('Loyalty card is inactive', { description: `${member.cardNumber} cannot earn or redeem points.` });
        return true;
      }
      setLoyaltyMember(member);
      if (!options.quiet) setRedeemPoints(null);
      if (member.customer) setCustomer({ id: member.customer.id, name: member.customer.name, phone: member.customer.phone, email: member.customer.email });
      if (!options.quiet) toast.success(`Loyalty member: ${member.customer?.name ?? member.cardNumber}`, { description: `${member.pointsBalance} points` });
      setCardDialogOpen(false);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        if (!options.quiet) toast.error('Loyalty member not found');
        return false;
      }
      toast.error(error instanceof ApiError ? error.message : 'Could not look up that card');
      return true;
    } finally {
      setCardLookupPending(false);
    }
  };
  const attachCardRef = React.useRef(attachCard);
  attachCardRef.current = attachCard;
  const loyaltyAvailableRef = React.useRef(loyaltyAvailable);
  loyaltyAvailableRef.current = loyaltyAvailable;

  const removeCard = () => {
    setLoyaltyMember(null);
    setRedeemPoints(null);
  };

  const handleBarcode = React.useCallback(
    async (code: string) => {
      // A membership card scanned anywhere on the till attaches the member instead of a product.
      if (loyaltyAvailableRef.current && isLoyaltyCardCode(code) && (await attachCardRef.current(code))) return;
      try {
        const matches = await productApi.posSearch({ q: code, limit: 5 });
        const variant =
          matches.find((m) => m.barcode === code) ??
          matches.find((m) => m.sku === code.toUpperCase()) ??
          (matches.length === 1 ? matches[0] : undefined);

        if (!variant) {
          toast.error('Product not found', { description: `No product matches barcode "${code}".` });
          return;
        }
        // Same rule as a tap on the grid: blocked without the permission, confirmed with it.
        if (requestAddRef.current(variant)) {
          toast.success(`${variant.productName} added`, { description: variant.variantName });
        }
      } catch {
        toast.error('Could not look up that barcode');
      }
    },
    [],
  );

  // Scanners type-and-Enter anywhere on the screen; no field needs focus first.
  useBarcodeScanner({ onScan: handleBarcode, enabled: !scanOpen && !outOfStockPending && !cardDialogOpen });

  const resetSale = () => {
    cart.clear();
    setCustomer(null);
    setNote('');
    payments.reset();
    removeCard();
    checkoutKey.current = newRequestKey('sale');
  };

  const handleCheckout = () => {
    // One sale at a time: F9 must not submit again while a sale is still being created.
    if (checkout.isPending) return;
    if (!canCheckout) {
      // The button is disabled, but a keyboard shortcut could still get here.
      toast.error('Cannot complete this sale', {
        description: issues[0]?.message ?? (redeemTooHigh ? `At most ${maxRedeemable} loyalty points can be used on this sale.` : payments.issues[0]),
      });
      return;
    }
    checkout.mutate();
  };

  // F9 completes the sale from anywhere on the screen.
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'F9') {
        event.preventDefault();
        handleCheckout();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  return (
    /*
      Layout.

      Desktop (lg+): two fixed-height columns side by side, each scrolling
      internally - unchanged.

      Mobile: the product grid owns the ONLY scroll area, and the cart lives in
      a bottom sheet behind a persistent summary bar. Previously the cart was
      stacked below the products, so with a large catalogue the cashier had to
      scroll past every product to reach checkout. Now the cart is one tap away
      no matter how far down the grid they are.
    */
    <div className="flex h-full min-h-0 flex-col">
      {/* The monthly sales allowance is the one limit that can stop a sale
          mid-transaction, so the warning belongs here, not only on the
          subscription page. It renders nothing below 80%, so it costs no space
          in the normal case - and it stays in flow rather than overlaying the
          till, which must never be covered. */}
      <LimitAlert resource="monthlySales" className="m-3 mb-0 shrink-0" />

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      {/* ------------------------------------------------ product search */}
      <section className="flex min-h-0 flex-1 flex-col border-b lg:border-b-0 lg:border-r">
        <ProductSearchPanel
          onSelect={handleProductSelect}
          currency={currency}
          onScanClick={() => setScanOpen(true)}
          canSellOutOfStock={canSellOutOfStock}
          onCardCode={loyaltyAvailable ? (code) => attachCard(code) : undefined}
        />
        {/* Room for the fixed summary bar so the last row is never covered. */}
        <div className="h-16 shrink-0 lg:hidden" aria-hidden />
      </section>

      {/* ------------------------------------- mobile cart summary bar */}
      <button
        type="button"
        onClick={() => setCartOpen(true)}
        className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t bg-primary px-4 py-3 text-primary-foreground shadow-lg lg:hidden"
      >
        <span className="relative">
          <ShoppingCart className="h-5 w-5" />
          {totals.lineCount > 0 && (
            <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-background px-1 text-[10px] font-bold text-foreground">
              {totals.itemCount}
            </span>
          )}
        </span>
        <span className="flex-1 text-left text-sm font-medium">
          {totals.lineCount === 0 ? 'Cart is empty' : `${totals.lineCount} line${totals.lineCount === 1 ? '' : 's'}`}
        </span>
        <span className="tabular text-base font-semibold">{formatMoney(totals.totalMinor, currency)}</span>
        <ChevronUp className="h-4 w-4" />
      </button>

      {/* ---------------------------------------------------------- cart */}
      {/* Backdrop for the mobile sheet. */}
      {cartOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setCartOpen(false)} aria-hidden />
      )}

      <section
        className={cn(
          'flex flex-col bg-card',
          // Mobile: a bottom sheet that slides over the grid.
          'fixed inset-x-0 bottom-0 z-50 max-h-[88vh] rounded-t-xl shadow-2xl transition-transform duration-200',
          cartOpen ? 'translate-y-0' : 'translate-y-full',
          // Desktop: a normal static column, always visible.
          'lg:static lg:z-auto lg:h-full lg:max-h-none lg:w-[420px] lg:translate-y-0 lg:rounded-none lg:shadow-none xl:w-[460px]',
        )}
      >
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between border-b bg-card px-4 lg:static">
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-4 w-4" />
            <h2 className="font-semibold">Cart</h2>
            {totals.lineCount > 0 && <Badge variant="secondary">{totals.itemCount} item{totals.itemCount === 1 ? '' : 's'}</Badge>}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            onClick={() => setCartOpen(false)}
            aria-label="Close cart"
          >
            <ChevronDown />
          </Button>
          {totals.lineCount > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
              <Eraser />
              Clear
            </Button>
          )}
        </header>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          <CartPanel
            lines={cart.state.lines}
            issues={issues}
            currency={currency}
            canChangePrice={canChangePrice}
            onQuantityChange={cart.setQuantity}
            onPriceChange={cart.setUnitPrice}
            onRemove={cart.removeLine}
          />
        </div>

        {/* Compact, so the cart list above keeps room for several lines on a laptop. */}
        <footer className="shrink-0 space-y-2 border-t p-3">
          <div className="flex items-stretch gap-2">
            <div className="min-w-0 flex-1">
              <CustomerPicker
                value={customer}
                onChange={(next) => {
                  setCustomer(next);
                  // A different customer (or none) cannot keep someone else's card.
                  if (loyaltyMember && next?.id !== loyaltyMember.customer?.id) removeCard();
                }}
                canCreate={canAddCustomer}
              />
            </div>
            {loyaltyAvailable && !loyaltyMember && (
              <Button type="button" variant="outline" size="sm" className="h-auto shrink-0" onClick={() => setCardDialogOpen(true)} title="Scan or enter a loyalty card">
                <CreditCard />
                <span className="hidden sm:inline">Card</span>
              </Button>
            )}
          </div>
          {loyaltyMember && (
            <LoyaltyStrip
              member={loyaltyMember}
              currency={currency}
              canRedeem={loyaltyAccess.canRedeem}
              redeemPoints={redeemPoints}
              maxRedeemable={maxRedeemable}
              pointsToEarn={pointsToEarn}
              onRedeemChange={setRedeemPoints}
              onRemove={removeCard}
            />
          )}

          {canDiscount && (
            <div className="flex items-end gap-2">
              <div className="w-32 space-y-1">
                <Label className="text-xs">Discount</Label>
                <Select
                  value={cart.state.discountType}
                  onValueChange={(value) => cart.setDiscount(value as 'none' | 'fixed' | 'percent', 0)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="fixed">Amount</SelectItem>
                    <SelectItem value="percent">Percent</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {cart.state.discountType === 'fixed' && (
                <MoneyInput
                  value={cart.state.discountValue || null}
                  onChange={(value) => cart.setDiscount('fixed', value ?? 0)}
                  className="flex-1"
                  ariaLabel="Discount amount"
                />
              )}

              {cart.state.discountType === 'percent' && (
                <div className="relative flex-1">
                  <Input
                    type="text"
                    inputMode="numeric"
                    className="tabular pr-7 text-right"
                    // Basis points under the hood keeps the value an integer.
                    value={cart.state.discountValue ? String(cart.state.discountValue / 100) : ''}
                    onChange={(event) => {
                      const raw = event.target.value;
                      if (raw === '') return cart.setDiscount('percent', 0);
                      if (!/^\d{0,3}(\.\d{0,2})?$/.test(raw)) return;
                      const percent = Number(raw);
                      if (percent > 100) return;
                      cart.setDiscount('percent', Math.round(percent * 100));
                    }}
                    aria-label="Discount percent"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    %
                  </span>
                </div>
              )}
            </div>
          )}

          {/* With VAT off the store's own setting leaves only Total (and a discount,
              if any): Subtotal would just repeat it, and the freed rows go to the
              cart list above. The sale maths is unchanged either way. */}
          <dl className="space-y-0.5 border-t pt-2 text-sm">
            {vatEnabled && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tabular">{formatMoney(totals.subtotalMinor, currency)}</dd>
              </div>
            )}
            {totals.discountMinor > 0 && (
              <div className="flex justify-between text-success">
                <dt>Discount</dt>
                <dd className="tabular">-{formatMoney(totals.discountMinor, currency)}</dd>
              </div>
            )}
            {totals.loyaltyDiscountMinor > 0 && (
              <div className="flex justify-between text-success">
                <dt className="flex items-center gap-1">
                  <Gift className="h-3.5 w-3.5" />
                  Loyalty ({redeemingPoints} pts)
                </dt>
                <dd className="tabular">-{formatMoney(totals.loyaltyDiscountMinor, currency)}</dd>
              </div>
            )}
            {vatEnabled && totals.taxMinor > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{store?.tax.label ?? 'Tax'}</dt>
                <dd className="tabular">{formatMoney(totals.taxMinor, currency)}</dd>
              </div>
            )}
            <div className={cn('flex justify-between text-base font-semibold', (vatEnabled || totals.discountMinor > 0 || totals.loyaltyDiscountMinor > 0) && 'border-t pt-1')}>
              <dt>Total</dt>
              <dd className="tabular">{formatMoney(totals.totalMinor, currency)}</dd>
            </div>
          </dl>

          {coveredByPoints ? (
            <p className="rounded-md bg-success/10 px-3 py-2 text-xs font-medium text-success">Paid in full with loyalty points - nothing to collect.</p>
          ) : (
          <PaymentPanel
            rows={payments.rows}
            availableMethods={availableMethods}
            totalMinor={totals.totalMinor}
            hasCash={payments.hasCash}
            remainingPayableMinor={payments.remainingPayableMinor}
            changeMinor={payments.changeMinor}
            dueMinor={payments.dueMinor}
            cashTyped={payments.cashTyped}
            issues={cartReady ? payments.issues : []}
            currency={currency}
            onAmountChange={payments.setAmount}
            onMethodChange={payments.setMethod}
            onAddRow={payments.addRow}
            onRemoveRow={payments.removeRow}
          />
          )}

          {issues.length > 0 && cart.state.lines.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                <p className="font-semibold">Fix before completing this sale:</p>
                <ul className="mt-0.5 list-inside list-disc">
                  {issues.slice(0, 3).map((issue, index) => (
                    <li key={index}>
                      {issue.productName ? `${issue.productName}: ` : ''}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <Button
            size="lg"
            className="w-full font-semibold"
            variant="success"
            disabled={!canCheckout}
            loading={checkout.isPending}
            onClick={handleCheckout}
          >
            <Banknote />
            Complete sale · {formatMoney(totals.totalMinor, currency)}
            <kbd className="ml-1 rounded bg-black/15 px-1.5 py-0.5 text-[10px] font-medium">F9</kbd>
          </Button>
        </footer>
      </section>

      <VariantPickerDialog
        group={pickerGroup}
        currency={currency}
        canSellOutOfStock={canSellOutOfStock}
        onSelect={(variant) => {
          setPickerGroup(null);
          requestAdd(variant);
        }}
        onClose={() => setPickerGroup(null)}
      />
      </div>

      <ScanDialog open={scanOpen} onOpenChange={setScanOpen} onSubmit={handleBarcode} />
      <LoyaltyCardDialog open={cardDialogOpen} onOpenChange={setCardDialogOpen} onSubmit={(code) => void attachCard(code)} loading={cardLookupPending} />

      {/* Opened only after the sale was created, so a receipt never prints for a failed sale. */}
      <ReceiptDialog saleId={receiptSaleId} autoPrint onClose={() => setReceiptSaleId(null)} onNewSale={() => setReceiptSaleId(null)} />

      <ConfirmDialog
        open={Boolean(outOfStockPending)}
        onOpenChange={(open) => !open && setOutOfStockPending(null)}
        title="Out-of-Stock Sale"
        description={
          outOfStockPending && (
            <span className="block space-y-1">
              <span className="block">This product currently has no available stock. You have permission to sell it anyway.</span>
              <span className="block font-medium text-foreground">
                {outOfStockPending.productName} · {outOfStockPending.variantName}
              </span>
              <span className="block">Current stock: {outOfStockPending.stock}</span>
            </span>
          )
        }
        confirmLabel="Sell Anyway"
        onConfirm={() => {
          if (outOfStockPending) cart.addVariant(outOfStockPending, 1, { allowOutOfStock: true });
          setOutOfStockPending(null);
        }}
      />

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear the cart?"
        description="Every line will be removed. This cannot be undone."
        confirmLabel="Clear cart"
        destructive
        onConfirm={() => {
          resetSale();
          setConfirmClear(false);
        }}
      />
    </div>
  );
}
