import * as React from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CreditCard, Minus, PauseCircle, Plus, ScanBarcode, Scale, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState, LoadingState } from '@/components/states';
import { MoneyInput } from '@/components/MoneyInput';
import { LimitAlert } from '@/components/LimitAlert';
import { useDebounced } from '@/components/SearchInput';
import { CustomerPicker, saleCustomerFields, type SelectedCustomer } from '@/features/customers/CustomerPicker';
import { LoyaltyCardDialog } from '@/features/loyalty/LoyaltyCardDialog';
import { LoyaltyStrip } from '@/features/loyalty/LoyaltyStrip';
import { isLoyaltyCardCode, maxRedeemablePoints, pointsForSpend } from '@/features/loyalty/loyaltyMath';
import { useLoyaltyAccess } from '@/features/loyalty/useLoyaltyAccess';
import { ANY, PosFilters } from '@/features/supershop/PosFilters';
import { loyaltyApi } from '@/api/endpoints';
import type { LoyaltyLookup } from '@/types/domain';
import { PaymentPanel } from '@/features/payments/PaymentPanel';
import { tenderedRows } from '@/features/payments/paymentMath';
import { usePayments } from '@/features/payments/usePayments';
import { ShopReceiptDialog } from '@/features/supershop/ShopReceiptDialog';
import { HeldSalesDialog } from '@/features/supershop/HeldSalesDialog';
import { ApiError } from '@/api/client';
import { storeApi } from '@/api/endpoints';
import { supershopApi } from '@/api/supershop';
import { shopCategoriesApi } from '@/api/posCategories';
import { shopBrandsApi } from '@/api/shopBrands';
import { formatMoney } from '@/lib/money';
import { formatQuantity, gramsToKgText, lineAmount, parseKgToGrams } from '@/lib/supershop';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import type { ShopProduct, ShopResumedSale } from '@/types/supershop';
import { tendersFromConfig } from '@/types/domain';

interface CartLine {
  product: ShopProduct;
  /** Pieces, or grams. */
  quantity: number;
}

/**
 * Supershop checkout: scan a barcode (Enter adds it) or search, weigh loose
 * goods, take payment, print. Totals are previews; the server prices every line
 * and works out VAT.
 */
export function SupershopPosPage() {
  const { activeStore, can } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const queryClient = useQueryClient();
  const scanRef = React.useRef<HTMLInputElement>(null);

  const [term, setTerm] = React.useState('');
  const search = useDebounced(term);
  const [cart, setCart] = React.useState<CartLine[]>([]);
  const [weighing, setWeighing] = React.useState<CartLine | { product: ShopProduct; quantity: 0 } | null>(null);
  const [discount, setDiscount] = React.useState<number | null>(0);
  const [customer, setCustomer] = React.useState<SelectedCustomer | null>(null);
  // Only a scanned CARD earns or redeems - never a customer or a phone number.
  const [loyaltyMember, setLoyaltyMember] = React.useState<LoyaltyLookup | null>(null);
  const [redeemPoints, setRedeemPoints] = React.useState<number | null>(null);
  const [cardDialogOpen, setCardDialogOpen] = React.useState(false);
  const loyaltyAccess = useLoyaltyAccess();
  // A till with this permission may sell goods the system thinks are gone -
  // the shelf is right and the record is wrong. The server checks it again.
  const canSellOutOfStock = can('sales.sellOutOfStock');
  const [receiptFor, setReceiptFor] = React.useState<string | null>(null);
  const [heldOpen, setHeldOpen] = React.useState(false);

  // The departments this shop sells under, in the owner's order and without the
  // ones they hid, and the brands its products actually carry.
  const { data: departments } = useQuery({ queryKey: ['supershop', 'categories', 'filter'], queryFn: () => shopCategoriesApi.list(), staleTime: 60_000 });
  // The managed brand list, minus any the owner has hidden.
  const { data: brandRows } = useQuery({ queryKey: ['supershop', 'brands', 'filter'], queryFn: () => shopBrandsApi.list(), staleTime: 60_000 });
  const brands = React.useMemo(() => (brandRows ?? []).map((row) => row.name), [brandRows]);
  const [department, setDepartment] = React.useState(ANY);
  const [brand, setBrand] = React.useState(ANY);

  // A department or brand that stops existing (renamed, its last product sold
  // off and deleted) quietly falls back to All rather than filtering the list
  // down to nothing with a dropdown that shows a blank.
  React.useEffect(() => {
    if (department !== ANY && departments && !departments.some((row) => row.name === department)) setDepartment(ANY);
  }, [departments, department]);
  React.useEffect(() => {
    if (brand !== ANY && brandRows && !brands.includes(brand)) setBrand(ANY);
  }, [brandRows, brands, brand]);

  const listRef = React.useRef<HTMLDivElement>(null);
  const sentinelRef = React.useRef<HTMLDivElement>(null);

  /**
   * The till's item list.
   *
   * Paged, and shown from the moment the screen opens: the shelf is what a
   * cashier browses when there is nothing to scan. The key holds the search text
   * and BOTH filters, so changing any of them starts again at page 1 and pages
   * from different filters never mix. Filtering happens on the server, so a
   * department or brand applies to the whole catalogue rather than to the page
   * already in the browser.
   *
   * Out-of-stock products are deliberately still listed - the row says so, and
   * whether it can be tapped is the `sales.sellOutOfStock` question below.
   */
  const {
    data: results,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['supershop', 'products', 'pos', search, department, brand],
    queryFn: ({ pageParam }) =>
      supershopApi.products({
        page: pageParam,
        limit: 40,
        activeOnly: 'true',
        ...(search ? { search } : {}),
        ...(department !== ANY ? { category: department } : {}),
        ...(brand !== ANY ? { brand } : {}),
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined),
    staleTime: 10_000,
  });

  // Every page loaded so far, as one list. Memoised so the rows below are not
  // rebuilt on every unrelated render (a keystroke in the payment panel).
  const products = React.useMemo(() => (results?.pages ?? []).flatMap((page) => page.items), [results]);
  const totalMatching = results?.pages[0]?.meta.total ?? 0;

  // A new search or filter shows its first page from the top.
  React.useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [search, department, brand]);

  // Infinite scroll: the next page loads as the end of the list comes into view.
  // The "Load more" button below is the fallback when the observer cannot run.
  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { root: listRef.current, rootMargin: '300px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const subtotal = cart.reduce((sum, line) => sum + lineAmount(line.product.priceMinor, line.quantity, line.product.unitType), 0);
  const discountMinor = Math.min(discount ?? 0, subtotal);
  const payableMinor = subtotal - discountMinor;
  // Points can pay for the goods after the discount, never more than that and
  // never more than the card holds. The server checks all of it again.
  const maxRedeemable = loyaltyMember ? maxRedeemablePoints(payableMinor, loyaltyMember.pointValueMinor, loyaltyMember.pointsBalance) : 0;
  const redeeming = Math.min(redeemPoints ?? 0, maxRedeemable);
  const loyaltyDiscountMinor = loyaltyMember ? redeeming * loyaltyMember.pointValueMinor : 0;
  const total = payableMinor - loyaltyDiscountMinor;
  // VAT is collected for the government, so it never earns points. This is the
  // till's estimate of it; the server works out the real figure per line.
  const vatEstimateMinor = cart.reduce(
    (sum, line) => sum + Math.floor((lineAmount(line.product.priceMinor, line.quantity, line.product.unitType) * line.product.vatRateBps) / (10_000 + line.product.vatRateBps)),
    0,
  );
  const pointsToEarn = loyaltyMember ? pointsForSpend(Math.max(0, total - vatEstimateMinor), loyaltyMember.earnSpendMinor) : 0;

  // The branch decides which tenders it takes; the till only offers those.
  const { data: posConfig } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });
  const loyaltyAvailable = loyaltyAccess.inPlan && posConfig?.loyalty?.available === true;
  const availableMethods = tendersFromConfig(posConfig);
  // The same payment maths as every other till: cash is what the customer
  // hands over, and change comes out of it.
  const payments = usePayments(cart.length > 0 ? total : 0);

  const setLine = (product: ShopProduct, quantity: number) =>
    setCart((current) => {
      const exists = current.some((line) => line.product._id === product._id);
      if (quantity <= 0) return current.filter((line) => line.product._id !== product._id);
      return exists
        ? current.map((line) => (line.product._id === product._id ? { ...line, quantity } : line))
        : [...current, { product, quantity }];
    });

  const add = (product: ShopProduct) => {
    if (!product.isActive) {
      toast.error(`${product.name} is not for sale`);
      return;
    }
    if (product.unitType === 'weight') {
      setWeighing(cart.find((line) => line.product._id === product._id) ?? { product, quantity: 0 });
      return;
    }
    const current = cart.find((line) => line.product._id === product._id)?.quantity ?? 0;
    const onHand = product.stock?.quantityOnHand ?? 0;
    // Out of stock entirely is what the permission covers; having SOME but not
    // enough is refused for everyone, here and on the server.
    const sellable = onHand <= 0 && canSellOutOfStock ? current + 1 : onHand;
    if (current + 1 > sellable) {
      toast.error(`Only ${onHand} of ${product.name} in stock`);
      return;
    }
    setLine(product, current + 1);
  };

  const scan = useMutation({
    mutationFn: (barcode: string) => supershopApi.lookup(barcode),
    onSuccess: (product) => {
      add(product);
      setTerm('');
    },
    onError: () => toast.error('No product has that barcode'),
  });

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
      if (member.customer) setCustomer({ id: member.customer.id, name: member.customer.name, phone: member.customer.phone, email: member.customer.email });
      toast.success(`Loyalty member: ${member.customer?.name ?? member.cardNumber}`, { description: `${member.pointsBalance} points` });
      setCardDialogOpen(false);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return false;
      toast.error(error instanceof ApiError ? error.message : 'Could not look up that card');
      return true;
    }
  };

  const removeCard = () => {
    setLoyaltyMember(null);
    setRedeemPoints(null);
  };

  const reset = () => {
    setCart([]);
    removeCard();
    setDiscount(0);
    setCustomer(null);
    payments.reset();
    scanRef.current?.focus();
  };

  // How many baskets are waiting at this branch, for the button's badge.
  const { data: heldSales } = useQuery({ queryKey: ['supershop', 'held-sales'], queryFn: () => supershopApi.heldSales(), staleTime: 10_000 });

  /**
   * Puts the basket aside. Nothing is sold: no stock moves, no money is taken
   * and no points are awarded - the server stores what was in front of the
   * cashier and prices it again when it comes back.
   */
  const hold = useMutation({
    mutationFn: () =>
      supershopApi.hold({
        items: cart.map((line) => ({ productId: line.product._id, quantity: line.quantity })),
        discountMinor,
        ...saleCustomerFields(customer),
        ...(loyaltyMember ? { loyaltyCardNumber: loyaltyMember.cardNumber } : {}),
      }),
    onSuccess: (result) => {
      toast.success(`${result.holdNumber} held`, { description: 'Open it again from Held sales.' });
      reset();
      void queryClient.invalidateQueries({ queryKey: ['supershop', 'held-sales'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not hold this sale'),
  });

  /** Puts a resumed basket back on the till, at today's prices. */
  const restore = async (sale: ShopResumedSale) => {
    setCart(sale.items.map((line) => ({ product: line.product, quantity: line.quantity })));
    setDiscount(sale.discountMinor);
    setCustomer(sale.customerDraft ? { name: sale.customerDraft.name, phone: sale.customerDraft.phone } : null);
    payments.reset();
    if (sale.loyaltyCardNumber) await attachCard(sale.loyaltyCardNumber);
    if (sale.dropped.length > 0) {
      toast.warning(`${sale.dropped.length} line(s) could not come back`, { description: sale.dropped.join(', ') });
    }
    const moved = sale.items.filter((line) => line.priceChanged);
    if (moved.length > 0) {
      toast.info('Prices have changed since this was held', { description: moved.map((line) => line.product.name).join(', ') });
    }
    toast.success(`${sale.holdNumber} reopened`);
    scanRef.current?.focus();
  };

  const complete = useMutation({
    mutationFn: () =>
      supershopApi.createSale({
        items: cart.map((line) => ({ productId: line.product._id, quantity: line.quantity })),
        // Cash carries what was handed over; the excess is the change.
        payments: tenderedRows(payments),
        discountMinor,
        ...saleCustomerFields(customer),
        // The card is what earns and redeems; the server re-checks both.
        ...(loyaltyMember ? { loyaltyMembershipId: loyaltyMember.id, redeemPoints: redeeming } : {}),
      }),
    onSuccess: (sale) => {
      toast.success(`${sale.saleNumber} completed`, {
        description: sale.changeMinor > 0 ? `Change due: ${formatMoney(sale.changeMinor, currency)}` : undefined,
      });
      reset();
      setReceiptFor(sale._id);
      void queryClient.invalidateQueries({ queryKey: ['supershop'] });
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) {
        toast.error('Could not complete the sale');
        return;
      }
      // A schema refusal carries the field that failed and why. Without it the
      // till shows only "The submitted data is not valid", which tells a cashier
      // nothing about which amount to correct.
      const [field, detail] = Object.entries(err.fieldErrors)[0] ?? [];
      toast.error(detail ?? err.message, {
        description: detail && field ? `Check: ${field.replace(/\.\d+\./g, ' ').replace(/\./g, ' ')}` : undefined,
      });
    },
  });

  const canComplete = cart.length > 0 && payments.isSettled && !complete.isPending;

  return (
    <div className="grid h-full gap-4 p-4 lg:grid-cols-[1fr_24rem] lg:p-6">
      <Card className="flex min-h-0 flex-col">
        <CardHeader className="space-y-3 pb-2">
          <CardTitle className="text-base">Scan or search</CardTitle>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const value = term.trim();
              if (!/^[A-Za-z0-9-]{3,64}$/.test(value)) return;
              // A membership card scanned into the product box attaches the
              // member rather than looking for goods that do not exist.
              if (loyaltyAvailable && isLoyaltyCardCode(value) && (await attachCard(value))) {
                setTerm('');
                return;
              }
              scan.mutate(value);
            }}
            className="relative"
          >
            <ScanBarcode className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              ref={scanRef}
              autoFocus
              className="pl-8"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Scan a barcode and press Enter, or type a name"
              aria-label="Scan or search"
            />
          </form>
          <PosFilters
            categories={(departments ?? []).map((row) => row.name)}
            brands={brands}
            category={department}
            brand={brand}
            onCategory={setDepartment}
            onBrand={setBrand}
          />
          <LimitAlert resource="monthlySales" />
        </CardHeader>
        <CardContent ref={listRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <LoadingState label="Loading products…" />
          ) : products.length === 0 ? (
            <EmptyState
              title="Nothing found"
              description={
                search || department !== ANY || brand !== ANY
                  ? 'Try another name, barcode, department or brand.'
                  : 'Add what you sell on Products & stock, and it will show up here.'
              }
            />
          ) : (
            <ul className="divide-y">
              {products.map((product) => {
                const onHand = product.stock?.quantityOnHand ?? 0;
                const blocked = onHand <= 0 && !canSellOutOfStock;
                return (
                  <li key={product._id}>
                    <button
                      type="button"
                      disabled={blocked}
                      onClick={() => add(product)}
                      className={cn('flex w-full items-center justify-between gap-3 px-1 py-2.5 text-left hover:bg-muted/50', blocked && 'cursor-not-allowed opacity-50')}
                    >
                      <div className="min-w-0">
                        <p className="font-medium">
                          {product.name} {product.unitType === 'weight' && <Badge variant="secondary">by weight</Badge>}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{[product.brand, product.category, product.barcode].filter(Boolean).join(' · ')}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="tabular font-semibold">
                          {formatMoney(product.priceMinor, currency)}
                          {product.unitType === 'weight' ? '/kg' : ''}
                        </p>
                        <p className={cn('text-xs', onHand <= 0 ? 'text-destructive' : 'text-muted-foreground')}>
                          {onHand > 0 ? `${formatQuantity(onHand, product.unitType)} in stock` : canSellOutOfStock ? 'Out of stock · sell anyway' : 'Out of stock'}
                        </p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Loads the next page when scrolled into view; the button is the fallback. */}
          <div ref={sentinelRef} className="h-px" aria-hidden />
          {hasNextPage && (
            <div className="flex justify-center py-3">
              <Button type="button" variant="outline" size="sm" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                Load more products
              </Button>
            </div>
          )}
          {!isLoading && products.length > 0 && !hasNextPage && totalMatching > 40 && (
            <p className="py-3 text-center text-xs text-muted-foreground">All {totalMatching} products shown</p>
          )}
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-col">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Basket · {cart.length} line(s)</CardTitle>
            <Button variant="outline" size="sm" onClick={() => setHeldOpen(true)}>
              <PauseCircle />
              Held{(heldSales ?? []).length > 0 ? ` · ${(heldSales ?? []).length}` : ''}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto">
          {cart.length === 0 ? (
            <p className="text-sm text-muted-foreground">Scan the first item.</p>
          ) : (
            <ul className="divide-y">
              {cart.map((line) => (
                <li key={line.product._id} className="flex items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{line.product.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatQuantity(line.quantity, line.product.unitType)} ·{' '}
                      {formatMoney(lineAmount(line.product.priceMinor, line.quantity, line.product.unitType), currency)}
                    </p>
                  </div>
                  {line.product.unitType === 'weight' ? (
                    <Button variant="outline" size="icon-sm" onClick={() => setWeighing(line)} aria-label={`Change weight of ${line.product.name}`}>
                      <Scale />
                    </Button>
                  ) : (
                    <>
                      <Button variant="outline" size="icon-sm" onClick={() => setLine(line.product, line.quantity - 1)} aria-label="One fewer">
                        <Minus />
                      </Button>
                      <span className="w-8 text-center tabular">{line.quantity}</span>
                      <Button variant="outline" size="icon-sm" onClick={() => add(line.product)} aria-label="One more">
                        <Plus />
                      </Button>
                    </>
                  )}
                  <Button variant="ghost" size="icon-sm" onClick={() => setLine(line.product, 0)} aria-label={`Remove ${line.product.name}`}>
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt>Subtotal (incl. VAT)</dt>
              <dd className="tabular">{formatMoney(subtotal, currency)}</dd>
            </div>
            {can('sales.discount') && (
              <div className="flex items-center justify-between gap-3">
                <dt>Discount</dt>
                <dd className="w-32">
                  <MoneyInput value={discount} onChange={setDiscount} ariaLabel="Discount" />
                </dd>
              </div>
            )}
            {loyaltyDiscountMinor > 0 && (
              <div className="flex justify-between text-success">
                <dt>Points ({redeeming})</dt>
                <dd className="tabular">-{formatMoney(loyaltyDiscountMinor, currency)}</dd>
              </div>
            )}
            <div className="flex justify-between text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular">{formatMoney(total, currency)}</dd>
            </div>
          </dl>

          <div className="flex items-stretch gap-2">
            <div className="min-w-0 flex-1">
              <CustomerPicker value={customer} onChange={setCustomer} canCreate={can('customers.create')} />
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

          <PaymentPanel
            rows={payments.rows}
            availableMethods={availableMethods}
            totalMinor={total}
            hasCash={payments.hasCash}
            remainingPayableMinor={payments.remainingPayableMinor}
            changeMinor={payments.changeMinor}
            dueMinor={payments.dueMinor}
            cashTyped={payments.cashTyped}
            issues={cart.length > 0 ? payments.issues : []}
            currency={currency}
            onAmountChange={payments.setAmount}
            onMethodChange={payments.setMethod}
            onAddRow={payments.addRow}
            onRemoveRow={payments.removeRow}
          />
        </CardContent>
        <div className="flex gap-2 border-t p-3">
          <Button variant="outline" onClick={reset} disabled={cart.length === 0}>
            Clear
          </Button>
          <Button variant="outline" disabled={cart.length === 0 || hold.isPending} loading={hold.isPending} onClick={() => hold.mutate()}>
            <PauseCircle />
            Hold
          </Button>
          <Button className="flex-1" disabled={!canComplete} loading={complete.isPending} onClick={() => complete.mutate()}>
            Complete sale · {formatMoney(total, currency)}
          </Button>
        </div>
      </Card>

      {heldOpen && <HeldSalesDialog currency={currency} onClose={() => setHeldOpen(false)} onResumed={(sale) => void restore(sale)} />}

      {weighing && (
        <WeighDialog
          key={weighing.product._id}
          line={weighing}
          currency={currency}
          canSellOutOfStock={canSellOutOfStock}
          onClose={() => {
            setWeighing(null);
            scanRef.current?.focus();
          }}
          onConfirm={(grams) => {
            setLine(weighing.product, grams);
            setWeighing(null);
            setTerm('');
            scanRef.current?.focus();
          }}
        />
      )}
      {/* Opened only by a completed sale, so it prints itself - no dialog, no
          printer picker. The sale is already saved; printing cannot undo it. */}
      <LoyaltyCardDialog open={cardDialogOpen} onOpenChange={setCardDialogOpen} onSubmit={(code) => attachCard(code)} />

      <ShopReceiptDialog saleId={receiptFor} onClose={() => setReceiptFor(null)} onNewSale={() => setReceiptFor(null)} autoPrint />
    </div>
  );
}

function WeighDialog({
  line,
  currency,
  canSellOutOfStock,
  onClose,
  onConfirm,
}: {
  line: { product: ShopProduct; quantity: number };
  currency: string;
  canSellOutOfStock: boolean;
  onClose: () => void;
  onConfirm: (grams: number) => void;
}) {
  const [kg, setKg] = React.useState(line.quantity > 0 ? gramsToKgText(line.quantity) : '');
  const grams = parseKgToGrams(kg);
  const onHand = line.product.stock?.quantityOnHand ?? 0;
  // Out of stock entirely is what the permission covers, not "not enough".
  const tooMuch = grams !== null && grams > onHand && !(onHand <= 0 && canSellOutOfStock);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{line.product.name}</DialogTitle>
          <DialogDescription>
            {formatMoney(line.product.priceMinor, currency)}/kg · {formatQuantity(onHand, 'weight')} in stock
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (grams !== null && !tooMuch) onConfirm(grams);
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="weigh-kg">Weight (kg)</Label>
            <Input id="weigh-kg" autoFocus inputMode="decimal" value={kg} onChange={(event) => setKg(event.target.value)} placeholder="1.25" />
          </div>
          {grams !== null && <p className="text-sm">Price: {formatMoney(lineAmount(line.product.priceMinor, grams, 'weight'), currency)}</p>}
          {kg !== '' && grams === null && <p className="text-sm text-destructive">Enter a weight like 0.5 or 1.25</p>}
          {tooMuch && <p className="text-sm text-destructive">Only {formatQuantity(onHand, 'weight')} in stock</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={grams === null || tooMuch}>
              {line.quantity > 0 ? 'Update' : 'Add'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
