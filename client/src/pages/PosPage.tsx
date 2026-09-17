import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Banknote, ChevronDown, ChevronUp, Eraser, ShoppingCart } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
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
import { productApi, saleApi, storeApi } from '@/api/endpoints';
import { useAuth } from '@/hooks/useAuth';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { PaymentMethod, Sale } from '@/types/domain';

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

  const canChangePrice = can('sales.changePrice');
  const canDiscount = can('sales.discount');
  const canAddCustomer = can('customers.create');

  const { data: store } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });
  const currency = store?.currency ?? activeStore?.currency ?? 'BDT';

  const totals = computeTotals(
    cart.state,
    store?.tax.rateBasisPoints ?? 0,
    Boolean(store?.tax.enabled && !store?.tax.inclusive),
  );
  const issues = validateCart(cart.state);
  const cartReady = cart.state.lines.length > 0 && issues.length === 0;

  const availableMethods = (store?.paymentMethods ?? ['cash']) as PaymentMethod[];
  const payments = usePayments(cartReady ? totals.totalMinor : 0);

  // Both halves must be satisfied: a valid cart AND a fully tendered amount.
  const canCheckout = cartReady && payments.isSettled;

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
        // The largest tender is recorded as the headline method; the full
        // breakdown travels in `payments` and is what the server trusts.
        paymentMethod: payments.rows
          .slice()
          .sort((a, b) => (b.amountMinor ?? 0) - (a.amountMinor ?? 0))[0].method,
        payments: payments.rows.map((row) => ({
          method: row.method,
          amountMinor: row.amountMinor ?? 0,
          reference: '',
        })),
        note,
      }),
    onSuccess: (sale) => {
      toast.success(`Sale ${sale.saleNumber} completed`, {
        description: `${formatMoney(sale.totalMinor, currency)} · ${sale.items.length} line${sale.items.length === 1 ? '' : 's'}`,
      });
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
    },
  });

  /**
   * A product with exactly one sellable variant goes straight into the cart;
   * anything with real options prompts for the variant first.
   */
  const handleProductSelect = (group: PosProductGroup) => {
    const sellable = group.variants.filter((variant) => variant.stock > 0);
    if (sellable.length === 1) {
      cart.addVariant(sellable[0]);
      return;
    }
    setPickerGroup(group);
  };

  /**
   * Barcode resolution. Looks the code up server-side, then adds the matching
   * variant. `cart.addVariant` increments an existing line rather than creating
   * a duplicate row, so scanning the same item twice reads as quantity 2.
   */
  const handleBarcode = React.useCallback(
    async (code: string) => {
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
        if (variant.stock <= 0) {
          toast.error('Out of stock', { description: `${variant.productName} (${variant.variantName})` });
          return;
        }

        cart.addVariant(variant);
        toast.success(`${variant.productName} added`, { description: variant.variantName });
      } catch {
        toast.error('Could not look up that barcode');
      }
    },
    [cart],
  );

  // Scanners type-and-Enter anywhere on the screen; no field needs focus first.
  useBarcodeScanner({ onScan: handleBarcode, enabled: !scanOpen });

  const resetSale = () => {
    cart.clear();
    setCustomer(null);
    setNote('');
    payments.reset();
  };

  const handleCheckout = () => {
    if (!canCheckout) {
      // The button is disabled, but a keyboard shortcut could still get here.
      toast.error('Cannot complete this sale', {
        description: issues[0]?.message ?? payments.issues[0],
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

        <footer className="shrink-0 space-y-3 border-t p-4">
          <CustomerPicker value={customer} onChange={setCustomer} canCreate={canAddCustomer} />

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

          <Separator />

          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="tabular">{formatMoney(totals.subtotalMinor, currency)}</dd>
            </div>
            {totals.discountMinor > 0 && (
              <div className="flex justify-between text-success">
                <dt>Discount</dt>
                <dd className="tabular">-{formatMoney(totals.discountMinor, currency)}</dd>
              </div>
            )}
            {totals.taxMinor > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{store?.tax.label ?? 'Tax'}</dt>
                <dd className="tabular">{formatMoney(totals.taxMinor, currency)}</dd>
              </div>
            )}
            <div className="flex justify-between border-t pt-1.5 text-lg font-semibold">
              <dt>Total</dt>
              <dd className="tabular">{formatMoney(totals.totalMinor, currency)}</dd>
            </div>
          </dl>

          <PaymentPanel
            rows={payments.rows}
            availableMethods={availableMethods}
            totalMinor={totals.totalMinor}
            allocatedMinor={payments.allocatedMinor}
            remainingMinor={payments.remainingMinor}
            changeMinor={payments.changeMinor}
            issues={cartReady ? payments.issues : []}
            currency={currency}
            onAmountChange={payments.setAmount}
            onMethodChange={payments.setMethod}
            onAddRow={payments.addRow}
            onRemoveRow={payments.removeRow}
          />

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
            size="xl"
            className="w-full"
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
        onSelect={(variant) => {
          cart.addVariant(variant);
          setPickerGroup(null);
        }}
        onClose={() => setPickerGroup(null)}
      />
      </div>

      <ScanDialog open={scanOpen} onOpenChange={setScanOpen} onSubmit={handleBarcode} />

      <ReceiptDialog saleId={receiptSaleId} onClose={() => setReceiptSaleId(null)} onNewSale={() => setReceiptSaleId(null)} />

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
