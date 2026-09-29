import * as React from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, CreditCard, Minus, PauseCircle, Plus, ScanBarcode, Scale, ShoppingCart, Trash2 } from 'lucide-react';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import { useBarcodeScanner } from '@/features/pos/useBarcodeScanner';
import { ShopReceiptDialog } from '@/features/supershop/ShopReceiptDialog';
import { HeldSalesDialog } from '@/features/supershop/HeldSalesDialog';
import {
  loadShopBasketDraft,
  saveShopBasketDraft,
  shopBasketDraftKey,
  type ShopDiscountMode,
} from '@/features/supershop/basketDraft';
import { ApiError } from '@/api/client';
import { storeApi } from '@/api/endpoints';
import { supershopApi } from '@/api/supershop';
import { shopCategoriesApi } from '@/api/posCategories';
import { shopBrandsApi } from '@/api/shopBrands';
import { formatMoney } from '@/lib/money';
import {
  formatQuantity,
  gramsToKgText,
  lineAmount,
  parseKgToGrams,
  parseVatPercent,
  roundShopTotal,
} from '@/lib/supershop';
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
  const { activeStore, can, session } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const queryClient = useQueryClient();
  const scanRef = React.useRef<HTMLInputElement>(null);

  const [term, setTerm] = React.useState('');
  const search = useDebounced(term);
  const [cart, setCart] = React.useState<CartLine[]>([]);
  const [weighing, setWeighing] = React.useState<CartLine | { product: ShopProduct; quantity: 0 } | null>(null);
  const [discountMode, setDiscountMode] = React.useState<ShopDiscountMode>('amount');
  const [discountAmount, setDiscountAmount] = React.useState<number | null>(0);
  const [discountPercent, setDiscountPercent] = React.useState('');
  const [customer, setCustomer] = React.useState<SelectedCustomer | null>(null);
  const [note, setNote] = React.useState('');
  // Only a scanned CARD earns or redeems - never a customer or a phone number.
  const [loyaltyMember, setLoyaltyMember] = React.useState<LoyaltyLookup | null>(null);
  const [redeemPoints, setRedeemPoints] = React.useState<number | null>(null);
  const [cardDialogOpen, setCardDialogOpen] = React.useState(false);
  const loyaltyAccess = useLoyaltyAccess();
  const [receiptFor, setReceiptFor] = React.useState<string | null>(null);
  const [heldOpen, setHeldOpen] = React.useState(false);
  // On a phone or a tablet the basket is a sheet that slides up from a bar at
  // the bottom. On a desktop it is simply the right-hand column and this is
  // ignored.
  const [basketOpen, setBasketOpen] = React.useState(false);
  const draftKey =
    session?.tenant && activeStore ? shopBasketDraftKey(session.tenant.id, activeStore.id, session.user.id) : null;
  const [loadedDraftKey, setLoadedDraftKey] = React.useState<string | null>(null);
  const reconciledDraftKey = React.useRef<string | null>(null);

  // The departments this shop sells under, in the owner's order and without the
  // ones they hid, and the brands its products actually carry.
  const { data: departments } = useQuery({
    queryKey: ['supershop', 'categories', 'filter'],
    queryFn: () => shopCategoriesApi.list(),
    staleTime: 60_000,
  });
  // The managed brand list, minus any the owner has hidden.
  const { data: brandRows } = useQuery({
    queryKey: ['supershop', 'brands', 'filter'],
    queryFn: () => shopBrandsApi.list(),
    staleTime: 60_000,
  });
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

  const subtotal = cart.reduce(
    (sum, line) => sum + lineAmount(line.product.priceMinor, line.quantity, line.product.unitType),
    0,
  );
  // Percent is parsed into integer basis points and multiplied while still in
  // minor units. No floating point value enters a checkout calculation.
  const discountBps = discountPercent.trim() === '' ? 0 : parseVatPercent(discountPercent);
  const requestedDiscountMinor =
    discountMode === 'percent'
      ? discountBps === null
        ? 0
        : Math.floor((subtotal * discountBps) / 10_000)
      : (discountAmount ?? 0);
  const discountExceedsSubtotal = discountMode === 'amount' && requestedDiscountMinor > subtotal;
  const discountIsValid = discountMode === 'amount' ? !discountExceedsSubtotal : discountBps !== null;
  const discountMinor = Math.min(requestedDiscountMinor, subtotal);
  const payableMinor = subtotal - discountMinor;
  // Points can pay for the goods after the discount, never more than that and
  // never more than the card holds. The server checks all of it again.
  const maxRedeemable = loyaltyMember
    ? maxRedeemablePoints(payableMinor, loyaltyMember.pointValueMinor, loyaltyMember.pointsBalance)
    : 0;
  const redeeming = Math.min(redeemPoints ?? 0, maxRedeemable);
  const loyaltyDiscountMinor = loyaltyMember ? redeeming * loyaltyMember.pointValueMinor : 0;
  const unroundedTotal = payableMinor - loyaltyDiscountMinor;
  const total = roundShopTotal(unroundedTotal);
  const roundingMinor = total - unroundedTotal;
  // VAT is collected for the government, so it never earns points. This is the
  // till's estimate of it; the server works out the real figure per line.
  const vatEstimateMinor = cart.reduce(
    (sum, line) =>
      sum +
      Math.floor(
        (lineAmount(line.product.priceMinor, line.quantity, line.product.unitType) * line.product.vatRateBps) /
          (10_000 + line.product.vatRateBps),
      ),
    0,
  );
  const pointsToEarn = loyaltyMember
    ? pointsForSpend(Math.max(0, unroundedTotal - vatEstimateMinor), loyaltyMember.earnSpendMinor)
    : 0;
  const hasOutOfStockLine = cart.some((line) => (line.product.stock?.quantityOnHand ?? 0) <= 0);

  // A note explains an out-of-stock line. Take that line out of the basket and
  // the explanation goes with it, rather than travelling silently to the server
  // on a sale it has nothing to do with.
  React.useEffect(() => {
    if (!hasOutOfStockLine) setNote('');
  }, [hasOutOfStockLine]);
  const outOfStockNoteValid = !hasOutOfStockLine || note.trim().length >= 3;

  // The branch decides which tenders it takes; the till only offers those.
  const { data: posConfig } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });
  const loyaltyAvailable = loyaltyAccess.inPlan && posConfig?.loyalty?.available === true;
  const availableMethods = tendersFromConfig(posConfig);
  // The same payment maths as every other till: cash is what the customer
  // hands over, and change comes out of it.
  const payments = usePayments(cart.length > 0 ? total : 0);
  const resetPayments = payments.reset;

  // Restore this cashier's draft whenever the active branch changes. The key is
  // deliberately tenant + branch + user scoped, so a shared browser never puts
  // one cashier's basket in front of another one.
  React.useEffect(() => {
    if (!draftKey) return;
    const draft = loadShopBasketDraft(draftKey);
    setCart(draft.cart);
    setDiscountMode(draft.discountMode);
    setDiscountAmount(draft.discountAmountMinor);
    setDiscountPercent(draft.discountPercent);
    setCustomer(draft.customer);
    setNote(draft.note);
    setLoyaltyMember(null);
    setRedeemPoints(null);
    resetPayments();
    reconciledDraftKey.current = null;
    setLoadedDraftKey(draftKey);
  }, [draftKey, resetPayments]);

  // Save after every meaningful basket edit. Empty means intentionally cleared
  // (sale, Hold, or Clear), so the persisted draft is removed.
  React.useEffect(() => {
    if (!draftKey || loadedDraftKey !== draftKey) return;
    saveShopBasketDraft(draftKey, {
      cart,
      discountMode,
      discountAmountMinor: discountAmount,
      discountPercent,
      customer,
      note,
    });
  }, [cart, customer, discountAmount, discountMode, discountPercent, draftKey, loadedDraftKey, note]);

  // Browser storage gives an immediate restore. Then refresh the catalogue
  // snapshots once so prices, active state and branch stock are current. The
  // API still revalidates all of this at checkout.
  React.useEffect(() => {
    if (!draftKey || loadedDraftKey !== draftKey || reconciledDraftKey.current === draftKey || cart.length === 0)
      return;
    reconciledDraftKey.current = draftKey;
    let cancelled = false;
    void Promise.all(
      cart.map(async (line) => {
        try {
          const current = await supershopApi.product(line.product._id);
          return { line: { product: current.product, quantity: line.quantity }, missing: false };
        } catch (error) {
          // Neither a confirmed deletion nor a temporary failure silently
          // clears a cashier's saved basket. Checkout will still reject an
          // unavailable product until the cashier removes it explicitly.
          return { line, missing: error instanceof ApiError && error.status === 404 };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const available = results.map((result) => result.line);
      const missing = results.filter((result) => result.missing).length;
      setCart(available);
      if (missing > 0) {
        toast.warning(`${missing} saved basket line${missing === 1 ? '' : 's'} is no longer in the catalogue`, {
          description: 'It was kept in the basket. Remove it manually before checkout.',
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cart, draftKey, loadedDraftKey]);

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
    // Anyone may sell when there is none, with a required note at checkout.
    // Having SOME but not enough remains blocked here and on the server.
    const sellable = onHand <= 0 ? current + 1 : onHand;
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
    onError: (err) => {
      // Product creation by scan belongs on Products & stock. Checkout only
      // sells catalogue items that already exist.
      toast.error(err instanceof ApiError && err.status !== 404 ? err.message : 'No product has that barcode');
    },
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
      if (member.customer)
        setCustomer({
          id: member.customer.id,
          name: member.customer.name,
          phone: member.customer.phone,
          email: member.customer.email,
        });
      toast.success(`Loyalty member: ${member.customer?.name ?? member.cardNumber}`, {
        description: `${member.pointsBalance} points`,
      });
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

  const handleBarcode = async (value: string) => {
    const barcode = value.trim();
    if (!/^[A-Za-z0-9-]{3,64}$/.test(barcode)) return;
    if (loyaltyAvailable && isLoyaltyCardCode(barcode) && (await attachCard(barcode))) {
      setTerm('');
      return;
    }
    scan.mutate(barcode);
  };

  const reset = () => {
    setCart([]);
    removeCard();
    setDiscountMode('amount');
    setDiscountAmount(0);
    setDiscountPercent('');
    setCustomer(null);
    setNote('');
    payments.reset();
    scanRef.current?.focus();
  };

  // How many baskets are waiting at this branch, for the button's badge.
  const { data: heldSales } = useQuery({
    queryKey: ['supershop', 'held-sales'],
    queryFn: () => supershopApi.heldSales(),
    staleTime: 10_000,
  });

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
        note,
      }),
    onSuccess: (result) => {
      toast.success(`${result.holdNumber} held`, { description: 'Open it again from Held sales.' });
      reset();
      setBasketOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['supershop', 'held-sales'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not hold this sale'),
  });

  /** Puts a resumed basket back on the till, at today's prices. */
  const restore = async (sale: ShopResumedSale) => {
    setCart(sale.items.map((line) => ({ product: line.product, quantity: line.quantity })));
    setDiscountMode('amount');
    setDiscountAmount(sale.discountMinor);
    setDiscountPercent('');
    setCustomer(sale.customer);
    setNote(sale.note);
    payments.reset();
    if (sale.loyaltyCardNumber) await attachCard(sale.loyaltyCardNumber);
    if (sale.dropped.length > 0) {
      toast.warning(`${sale.dropped.length} line(s) could not come back`, { description: sale.dropped.join(', ') });
    }
    const moved = sale.items.filter((line) => line.priceChanged);
    if (moved.length > 0) {
      toast.info('Prices have changed since this was held', {
        description: moved.map((line) => line.product.name).join(', '),
      });
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
        note,
      }),
    onSuccess: (sale) => {
      toast.success(`${sale.saleNumber} completed`, {
        description: sale.changeMinor > 0 ? `Change due: ${formatMoney(sale.changeMinor, currency)}` : undefined,
      });
      reset();
      setBasketOpen(false);
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

  // USB/Bluetooth scanners act like fast keyboards. This listener works when
  // focus is on the product list, basket or page chrome; the search box is also
  // explicitly marked as a scan target below.
  useBarcodeScanner({
    onScan: (barcode) => void handleBarcode(barcode),
    minLength: 3,
    enabled: !weighing && !heldOpen && !cardDialogOpen && receiptFor === null && !complete.isPending,
  });

  const canComplete =
    cart.length > 0 && discountIsValid && outOfStockNoteValid && payments.isSettled && !complete.isPending;

  return (
    <div className="flex h-full flex-col gap-4 p-4 lg:grid lg:grid-cols-[1fr_24rem] lg:p-6">
      <Card className="flex min-h-0 flex-1 flex-col lg:flex-none">
        <CardHeader className="space-y-3 pb-2">
          <CardTitle className="text-base">Scan or search</CardTitle>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              await handleBarcode(term);
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
              data-barcode-target="true"
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
                return (
                  <li key={product._id}>
                    <button
                      type="button"
                      onClick={() => add(product)}
                      className="flex w-full items-center justify-between gap-3 px-1 py-2.5 text-left hover:bg-muted/50"
                    >
                      <div className="min-w-0">
                        <p className="font-medium">
                          {product.name} {product.unitType === 'weight' && <Badge variant="secondary">by weight</Badge>}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[product.brand, product.category, product.barcode].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="tabular font-semibold">
                          {formatMoney(product.priceMinor, currency)}
                          {product.unitType === 'weight' ? '/kg' : ''}
                        </p>
                        <p className={cn('text-xs', onHand <= 0 ? 'text-destructive' : 'text-muted-foreground')}>
                          {onHand > 0 ? `${formatQuantity(onHand, product.unitType)} in stock` : 'Out of stock · note required'}
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
              >
                Load more products
              </Button>
            </div>
          )}
          {!isLoading && products.length > 0 && !hasNextPage && totalMatching > 40 && (
            <p className="py-3 text-center text-xs text-muted-foreground">All {totalMatching} products shown</p>
          )}
          {/* Room for the bar fixed to the bottom, so the last row is reachable. */}
          <div className="h-16 lg:hidden" aria-hidden />
        </CardContent>
      </Card>

      {/* ------------------------------------------- the basket, on a phone */}
      <button
        type="button"
        onClick={() => setBasketOpen(true)}
        className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t bg-primary px-4 py-3 text-primary-foreground shadow-lg lg:hidden"
      >
        <span className="relative">
          <ShoppingCart className="h-5 w-5" />
          {cart.length > 0 && (
            <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-background px-1 text-[10px] font-bold text-foreground">
              {cart.length}
            </span>
          )}
        </span>
        <span className="flex-1 text-left text-sm font-medium">
          {cart.length === 0 ? 'Basket is empty' : `${cart.length} line${cart.length === 1 ? '' : 's'}`}
        </span>
        <span className="tabular text-base font-semibold">{formatMoney(total, currency)}</span>
        <ChevronUp className="h-4 w-4" />
      </button>

      {basketOpen && <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setBasketOpen(false)} aria-hidden />}

      <Card
        className={cn(
          'flex flex-col',
          // Phone and tablet: a sheet that slides up over the shelf, reached
          // from the bar above. The WHOLE sheet scrolls as one, so the tender
          // block is never a little scrolling window of its own.
          'fixed inset-x-0 bottom-0 z-50 max-h-[88vh] rounded-t-xl shadow-2xl transition-transform duration-200',
          basketOpen ? 'translate-y-0' : 'translate-y-full',
          // Desktop: the right-hand column, always there.
          'lg:static lg:z-auto lg:h-full lg:min-h-0 lg:max-h-none lg:translate-y-0 lg:rounded-xl lg:shadow-sm',
        )}
      >
        <CardHeader className="shrink-0 pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Basket · {cart.length} line(s)</CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setHeldOpen(true)}>
                <PauseCircle />
                Held{(heldSales ?? []).length > 0 ? ` · ${(heldSales ?? []).length}` : ''}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="lg:hidden"
                onClick={() => setBasketOpen(false)}
                aria-label="Close the basket"
              >
                <ChevronDown />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto p-0 lg:overflow-hidden">
          {/*
            The basket keeps a floor and the panel below it a ceiling.
            Everything under the list - totals, customer, loyalty, note, tender -
            used to be `shrink-0`, so attaching a customer or a loyalty card grew
            it until the basket had no room left and the cashier could not see
            what they had scanned. Now the list always shows a few lines and the
            panel scrolls once it has had its share.
          */}
          <div className="scrollbar-thin px-4 lg:min-h-[6.5rem] lg:flex-1 lg:overflow-y-auto">
            {cart.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">Scan the first item.</p>
            ) : (
              <ul className="divide-y">
                {cart.map((line) => (
                  <li key={line.product._id} className="flex items-center gap-1.5 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium leading-tight">{line.product.name}</p>
                      <p className="text-xs leading-tight text-muted-foreground">
                        {formatQuantity(line.quantity, line.product.unitType)} ·{' '}
                        {formatMoney(
                          lineAmount(line.product.priceMinor, line.quantity, line.product.unitType),
                          currency,
                        )}
                      </p>
                    </div>
                    {line.product.unitType === 'weight' ? (
                      <Button
                        variant="outline"
                        size="icon-sm"
                        onClick={() => setWeighing(line)}
                        aria-label={`Change weight of ${line.product.name}`}
                      >
                        <Scale />
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          onClick={() => setLine(line.product, line.quantity - 1)}
                          aria-label="One fewer"
                        >
                          <Minus />
                        </Button>
                        <span className="w-7 text-center text-sm tabular">{line.quantity}</span>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          onClick={() => add(line.product)}
                          aria-label="One more"
                        >
                          <Plus />
                        </Button>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setLine(line.product, 0)}
                      aria-label={`Remove ${line.product.name}`}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/*
            On a phone and a tablet this is part of the one sheet scroll: it has
            no ceiling and no scrollbar of its own, so a cashier is never
            scrolling inside a scroll. On a desktop it keeps its share of a
            fixed-height column and scrolls there instead.
          */}
          <div className="scrollbar-thin space-y-1.5 border-t px-4 py-2 lg:max-h-[58%] lg:min-h-0 lg:shrink lg:overflow-y-auto">
            <dl className="space-y-0.5 text-sm">
              <div className="flex justify-between">
                <dt>Subtotal (incl. VAT)</dt>
                <dd className="tabular">{formatMoney(subtotal, currency)}</dd>
              </div>
              {can('sales.discount') && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <dt>Discount</dt>
                    <dd className="flex min-w-0 items-center gap-1.5">
                      <Select
                        value={discountMode}
                        onValueChange={(value) => setDiscountMode(value as ShopDiscountMode)}
                      >
                        <SelectTrigger className="h-8 w-[92px]" aria-label="Discount type">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="amount">Amount</SelectItem>
                          <SelectItem value="percent">Percent</SelectItem>
                        </SelectContent>
                      </Select>
                      {discountMode === 'amount' ? (
                        <MoneyInput
                          value={discountAmount}
                          onChange={setDiscountAmount}
                          className="w-28 [&_input]:h-8"
                          ariaLabel="Discount amount"
                        />
                      ) : (
                        <div className="relative w-24">
                          <Input
                            value={discountPercent}
                            onChange={(event) => setDiscountPercent(event.target.value)}
                            inputMode="decimal"
                            maxLength={6}
                            className="h-8 pr-7 text-right tabular"
                            aria-label="Discount percent"
                            aria-invalid={discountBps === null}
                            placeholder="0"
                          />
                          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                            %
                          </span>
                        </div>
                      )}
                    </dd>
                  </div>
                  {discountMode === 'percent' && discountBps !== null && discountMinor > 0 && (
                    <p className="text-right text-xs text-muted-foreground">-{formatMoney(discountMinor, currency)}</p>
                  )}
                  {discountMode === 'percent' && discountBps === null && (
                    <p className="text-right text-xs text-destructive">
                      Enter a percentage from 0 to 100, with at most 2 decimals.
                    </p>
                  )}
                  {discountExceedsSubtotal && (
                    <p className="text-right text-xs text-destructive">Discount cannot be more than the subtotal.</p>
                  )}
                </div>
              )}
              {loyaltyDiscountMinor > 0 && (
                <div className="flex justify-between text-success">
                  <dt>Points ({redeeming})</dt>
                  <dd className="tabular">-{formatMoney(loyaltyDiscountMinor, currency)}</dd>
                </div>
              )}
              {roundingMinor !== 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <dt>Rounding</dt>
                  <dd className="tabular">
                    {roundingMinor > 0 ? '+' : ''}
                    {formatMoney(roundingMinor, currency)}
                  </dd>
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto shrink-0"
                  onClick={() => setCardDialogOpen(true)}
                  title="Scan or enter a loyalty card"
                >
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

            {/*
              The note is only ever asked for to explain a sale of goods the
              system says are gone. An ordinary basket needs no note, so the
              field is not there to be wondered about - it appears with the
              out-of-stock line that makes it compulsory, and goes with it.
            */}
            {hasOutOfStockLine && (
              <div className="space-y-1">
                <Label htmlFor="shop-sale-note" className="text-xs">
                  Sale note <span className="text-destructive">(required for out-of-stock sale)</span>
                </Label>
                <Input
                  id="shop-sale-note"
                  className="h-8"
                  value={note}
                  maxLength={300}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Why is this stock-out sale allowed?"
                  aria-invalid={!outOfStockNoteValid}
                />
                {!outOfStockNoteValid && (
                  <p className="text-xs text-destructive">Enter at least 3 characters before completing this sale.</p>
                )}
              </div>
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
              issues={cart.length > 0 ? payments.issues : []}
              currency={currency}
              onAmountChange={payments.setAmount}
              onMethodChange={payments.setMethod}
              onAddRow={payments.addRow}
              onRemoveRow={payments.removeRow}
            />
          </div>
        </CardContent>
        <div className="flex shrink-0 gap-2 border-t p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] lg:pb-2.5">
          <Button variant="outline" onClick={reset} disabled={cart.length === 0}>
            Clear
          </Button>
          <Button
            variant="outline"
            disabled={cart.length === 0 || !discountIsValid || hold.isPending}
            loading={hold.isPending}
            onClick={() => hold.mutate()}
          >
            <PauseCircle />
            Hold
          </Button>
          <Button
            className="flex-1"
            disabled={!canComplete}
            loading={complete.isPending}
            onClick={() => complete.mutate()}
          >
            Complete sale · {formatMoney(total, currency)}
          </Button>
        </div>
      </Card>

      {heldOpen && (
        <HeldSalesDialog
          currency={currency}
          onClose={() => setHeldOpen(false)}
          onResumed={(sale) => void restore(sale)}
        />
      )}

      {weighing && (
        <WeighDialog
          key={weighing.product._id}
          line={weighing}
          currency={currency}
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

      <ShopReceiptDialog
        saleId={receiptFor}
        onClose={() => setReceiptFor(null)}
        onNewSale={() => setReceiptFor(null)}
        autoPrint
      />
    </div>
  );
}

function WeighDialog({
  line,
  currency,
  onClose,
  onConfirm,
}: {
  line: { product: ShopProduct; quantity: number };
  currency: string;
  onClose: () => void;
  onConfirm: (grams: number) => void;
}) {
  const [kg, setKg] = React.useState(line.quantity > 0 ? gramsToKgText(line.quantity) : '');
  const grams = parseKgToGrams(kg);
  const onHand = line.product.stock?.quantityOnHand ?? 0;
  // Anyone may sell a stock-out item with a note, but not exceed a positive balance.
  const tooMuch = grams !== null && onHand > 0 && grams > onHand;

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
            <Input
              id="weigh-kg"
              autoFocus
              inputMode="decimal"
              value={kg}
              onChange={(event) => setKg(event.target.value)}
              placeholder="1.25"
            />
          </div>
          {grams !== null && (
            <p className="text-sm">
              Price: {formatMoney(lineAmount(line.product.priceMinor, grams, 'weight'), currency)}
            </p>
          )}
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
