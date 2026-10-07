import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, CreditCard, FileText, Minus, PauseCircle, Plus, Search, ShoppingCart, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, LoadingState } from '@/components/states';
import { MoneyInput } from '@/components/MoneyInput';
import { LimitAlert } from '@/components/LimitAlert';
import { useDebounced } from '@/components/SearchInput';
import { CustomerPicker, saleCustomerFields, type SelectedCustomer } from '@/features/customers/CustomerPicker';
import { PaymentPanel } from '@/features/payments/PaymentPanel';
import { tenderedRows } from '@/features/payments/paymentMath';
import { usePayments } from '@/features/payments/usePayments';
import { PharmacyReceiptDialog } from '@/features/pharmacy/PharmacyReceiptDialog';
import { PharmacyHeldSalesDialog } from '@/features/pharmacy/PharmacyHeldSalesDialog';
import { LoyaltyCardDialog } from '@/features/loyalty/LoyaltyCardDialog';
import { LoyaltyStrip } from '@/features/loyalty/LoyaltyStrip';
import { isLoyaltyCardCode, maxRedeemablePoints, pointsForSpend } from '@/features/loyalty/loyaltyMath';
import { useLoyaltyAccess } from '@/features/loyalty/useLoyaltyAccess';
import { ApiError } from '@/api/client';
import { loyaltyApi, storeApi } from '@/api/endpoints';
import { pharmacyApi } from '@/api/pharmacy';
import { pharmacyCategoriesApi } from '@/api/posCategories';
import { formatMoney } from '@/lib/money';
import { dosageFormLabel, formatExpiry } from '@/lib/pharmacy';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import type { Medicine, PharmacyResumedSale } from '@/types/pharmacy';
import type { LoyaltyLookup } from '@/types/domain';
import { tendersFromConfig } from '@/types/domain';

interface CartLine {
  medicine: Medicine;
  quantity: number;
  /** Captured from a real stock snapshot when the line enters the cart. */
  requiresOutOfStockNote?: boolean;
}

const EMPTY_RX = { patientName: '', prescriberName: '', prescriptionNumber: '' };
const QUICK_QUANTITIES = [5, 10, 15, 20] as const;
const percentToBps = (value: string): number | null => {
  const clean = value.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(clean)) return null;
  const bps = Math.round(Number(clean) * 100);
  return bps <= 10_000 ? bps : null;
};

/**
 * Pharmacy point of sale. Totals shown here are previews: the server prices
 * every line from the catalogue, picks the batches (earliest expiry first,
 * never expired) and can optionally record prescription details for Rx medicines.
 */
export function PharmacyPosPage() {
  const { activeStore, can, session } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const queryClient = useQueryClient();
  const draftKey = `pharmacy-pos-draft:${session?.tenant?.id ?? 'none'}:${activeStore?.id ?? 'none'}`;
  const initialDraft = React.useMemo(() => {
    try { return JSON.parse(localStorage.getItem(draftKey) ?? 'null') as { cart?: CartLine[]; discount?: number | null; discountMode?: 'amount' | 'percent'; discountPercent?: string; rx?: typeof EMPTY_RX; note?: string; customer?: SelectedCustomer | null } | null; }
    catch { return null; }
  }, [draftKey]);

  const [term, setTerm] = React.useState('');
  const search = useDebounced(term);
  const [cart, setCart] = React.useState<CartLine[]>(initialDraft?.cart ?? []);
  const [discount, setDiscount] = React.useState<number | null>(initialDraft?.discount ?? 0);
  const [discountMode, setDiscountMode] = React.useState<'amount' | 'percent'>(initialDraft?.discountMode ?? 'amount');
  const [discountPercent, setDiscountPercent] = React.useState(initialDraft?.discountPercent ?? '');
  const [rx, setRx] = React.useState(initialDraft?.rx ?? EMPTY_RX);
  const [note, setNote] = React.useState(initialDraft?.note ?? '');
  const [customer, setCustomer] = React.useState<SelectedCustomer | null>(initialDraft?.customer ?? null);
  // Only a scanned CARD earns or redeems - never a customer or a phone number.
  const [loyaltyMember, setLoyaltyMember] = React.useState<LoyaltyLookup | null>(null);
  const [redeemPoints, setRedeemPoints] = React.useState<number | null>(null);
  const [cardDialogOpen, setCardDialogOpen] = React.useState(false);
  const loyaltyAccess = useLoyaltyAccess();
  const [receiptFor, setReceiptFor] = React.useState<string | null>(null);
  const [heldOpen, setHeldOpen] = React.useState(false);
  const [mobilePanel, setMobilePanel] = React.useState<'cart' | 'payment' | null>(null);
  const loadedDraftKey = React.useRef(draftKey);
  const skipDraftSave = React.useRef(false);

  React.useEffect(() => {
    if (loadedDraftKey.current === draftKey) return;
    loadedDraftKey.current = draftKey;
    skipDraftSave.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? 'null') as typeof initialDraft;
      setCart(saved?.cart ?? []); setDiscount(saved?.discount ?? 0);
      setDiscountMode(saved?.discountMode ?? 'amount'); setDiscountPercent(saved?.discountPercent ?? '');
      setRx(saved?.rx ?? EMPTY_RX); setNote(saved?.note ?? ''); setCustomer(saved?.customer ?? null);
    } catch {
      setCart([]); setDiscount(0); setDiscountMode('amount'); setDiscountPercent('');
      setRx(EMPTY_RX); setNote(''); setCustomer(null);
    }
  }, [draftKey, initialDraft]);

  React.useEffect(() => {
    if (skipDraftSave.current) { skipDraftSave.current = false; return; }
    if (cart.length === 0) { localStorage.removeItem(draftKey); return; }
    localStorage.setItem(draftKey, JSON.stringify({ cart, discount, discountMode, discountPercent, rx, note, customer }));
  }, [cart, customer, discount, discountMode, discountPercent, draftKey, note, rx]);

  // The categories this pharmacy groups its shelves by, in the owner's order
  // and without the ones they hid.
  const { data: shelves } = useQuery({ queryKey: ['pharmacy', 'categories', 'filter'], queryFn: () => pharmacyCategoriesApi.list() });
  const { data: medicineFilters } = useQuery({ queryKey: ['pharmacy', 'medicine-filters'], queryFn: pharmacyApi.medicineFilters });
  const [category, setCategory] = React.useState('all');
  const [manufacturer, setManufacturer] = React.useState('all');
  const [medicinePage, setMedicinePage] = React.useState(1);
  const medicineListRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setMedicinePage(1);
  }, [search, category, manufacturer]);

  const { data: results, isLoading } = useQuery({
    queryKey: ['pharmacy', 'medicines', 'pos', search, category, manufacturer, medicinePage],
    queryFn: () =>
      pharmacyApi.medicines({ page: medicinePage, limit: 20, activeOnly: 'true', ...(search ? { search } : {}), ...(category !== 'all' ? { category } : {}), ...(manufacturer !== 'all' ? { manufacturer } : {}) }),
  });

  const changeMedicinePage = (page: number) => {
    setMedicinePage(page);
    medicineListRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const subtotal = cart.reduce((sum, line) => sum + line.medicine.sellingPriceMinor * line.quantity, 0);
  const discountBps = percentToBps(discountPercent || '0');
  const discountValid = discountMode === 'amount' ? (discount ?? 0) <= subtotal : discountBps !== null;
  const discountMinor = discountMode === 'amount' ? (discountValid ? discount ?? 0 : 0) : Math.floor((subtotal * (discountBps ?? 0)) / 10_000);
  const payableMinor = subtotal - discountMinor;
  // Points can pay for the medicines after the discount, never more than that
  // and never more than the card holds. The server checks all of it again.
  const maxRedeemable = loyaltyMember ? maxRedeemablePoints(payableMinor, loyaltyMember.pointValueMinor, loyaltyMember.pointsBalance) : 0;
  const redeeming = Math.min(redeemPoints ?? 0, maxRedeemable);
  const loyaltyDiscountMinor = loyaltyMember ? redeeming * loyaltyMember.pointValueMinor : 0;
  const total = payableMinor - loyaltyDiscountMinor;
  // Prescription medicines never earn points. The till shows what the rest of
  // the basket earns, scaled by what is actually being charged; the server
  // works the real figure out the same way.
  const overTheCounterMinor = cart
    .filter((line) => !line.medicine.requiresPrescription)
    .reduce((sum, line) => sum + line.medicine.sellingPriceMinor * line.quantity, 0);
  const qualifyingMinor = subtotal > 0 ? Math.floor((overTheCounterMinor * total) / subtotal) : 0;
  const pointsToEarn = loyaltyMember ? pointsForSpend(qualifyingMinor, loyaltyMember.earnSpendMinor) : 0;

  // The branch decides which tenders it takes; the till only offers those.
  const { data: posConfig } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig });
  const loyaltyAvailable = loyaltyAccess.inPlan && posConfig?.loyalty?.available === true;
  const availableMethods = tendersFromConfig(posConfig);
  // The same payment maths as every other till: cash is what the customer
  // hands over, and change comes out of it.
  const payments = usePayments(cart.length > 0 ? total : 0);
  const needsRx = cart.some((line) => line.medicine.requiresPrescription);
  const rxComplete = rx.patientName.trim().length >= 2 && rx.prescriberName.trim().length >= 2;
  const hasOutOfStockLine = cart.some((line) =>
    line.requiresOutOfStockNote === true ||
    (line.requiresOutOfStockNote === undefined && line.medicine.stock !== undefined && line.medicine.stock.sellable <= 0),
  );
  const outOfStockNoteValid = !hasOutOfStockLine || note.trim().length >= 3;

  React.useEffect(() => {
    if (!hasOutOfStockLine) setNote('');
  }, [hasOutOfStockLine]);

  const add = (medicine: Medicine, amount = 1) => {
    const sellable = medicine.stock?.sellable ?? 0;
    const existing = cart.find((line) => line.medicine._id === medicine._id);
    const target = (existing?.quantity ?? 0) + amount;
    // A completely empty line may be sold by any cashier with a note. Having
    // some stock but asking for more than it remains a counting error.
    if (target > sellable && sellable > 0) {
      toast.error(sellable <= 0 ? `${medicine.name} is out of stock` : `Only ${sellable} of ${medicine.name} in stock`);
      return;
    }
    setCart(
      existing
        ? cart.map((line) => (line.medicine._id === medicine._id
          ? { ...line, quantity: target, requiresOutOfStockNote: line.requiresOutOfStockNote ?? (medicine.stock !== undefined && sellable <= 0) }
          : line))
        : [...cart, { medicine, quantity: amount, requiresOutOfStockNote: medicine.stock !== undefined && sellable <= 0 }],
    );
  };

  const setQuantity = (id: string, quantity: number) => {
    const line = cart.find((entry) => entry.medicine._id === id);
    if (!line) return;
    const clean = Math.min(Math.max(Math.trunc(quantity), 0), 10_000);
    const sellable = line.medicine.stock?.sellable ?? 0;
    if (clean > sellable && sellable > 0) { toast.error(`Only ${sellable} of ${line.medicine.name} in stock`); return; }
    setCart(cart.flatMap((entry) => (entry.medicine._id !== id ? [entry] : clean <= 0 ? [] : [{ ...entry, quantity: clean }])));
  };

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
    setDiscount(0);
    setDiscountPercent('');
    setRx(EMPTY_RX);
    setNote('');
    setCustomer(null);
    removeCard();
    payments.reset();
    localStorage.removeItem(draftKey);
  };

  const { data: heldSales } = useQuery({ queryKey: ['pharmacy', 'held-sales'], queryFn: pharmacyApi.heldSales, staleTime: 10_000 });
  const hold = useMutation({
    mutationFn: () => pharmacyApi.hold({
      items: cart.map((line) => ({ medicineId: line.medicine._id, quantity: line.quantity })),
      discountMinor,
      ...saleCustomerFields(customer),
      ...(rxComplete ? { prescription: { patientName: rx.patientName.trim(), prescriberName: rx.prescriberName.trim(), prescriptionNumber: rx.prescriptionNumber.trim() } } : {}),
      ...(loyaltyMember ? { loyaltyCardNumber: loyaltyMember.cardNumber } : {}),
      note: hasOutOfStockLine ? note.trim() : '',
    }),
    onSuccess: (result) => {
      toast.success(`${result.holdNumber} held`, { description: customer?.name ? `Customer: ${customer.name}` : 'Open it later from Held sales.' });
      reset(); setMobilePanel(null);
      void queryClient.invalidateQueries({ queryKey: ['pharmacy', 'held-sales'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not hold this sale'),
  });

  const restore = async (sale: PharmacyResumedSale) => {
    setCart(sale.items.map((line) => ({
      medicine: line.medicine,
      quantity: line.quantity,
      requiresOutOfStockNote: line.medicine.stock !== undefined && line.medicine.stock.sellable <= 0,
    })));
    setDiscountMode('amount'); setDiscount(sale.discountMinor); setDiscountPercent('');
    setRx(sale.prescription ? { patientName: sale.prescription.patientName, prescriberName: sale.prescription.prescriberName, prescriptionNumber: sale.prescription.prescriptionNumber } : EMPTY_RX);
    setCustomer(sale.customer); setNote(sale.note); payments.reset();
    if (sale.loyaltyCardNumber) await attachCard(sale.loyaltyCardNumber);
    if (sale.dropped.length) toast.warning(`${sale.dropped.length} unavailable line(s) were removed`, { description: sale.dropped.join(', ') });
    if (sale.items.some((line) => line.priceChanged)) toast.info('Some medicine prices changed while this sale was held');
    toast.success(`${sale.holdNumber} reopened`);
    // Desktop already shows Cart and Payment as permanent columns. Opening the
    // responsive drawer there would cover the medicine catalogue until reload.
    setMobilePanel(window.matchMedia('(max-width: 1279px)').matches ? 'cart' : null);
  };

  const complete = useMutation({
    mutationFn: () =>
      pharmacyApi.createSale({
        items: cart.map((line) => ({ medicineId: line.medicine._id, quantity: line.quantity })),
        // Cash carries what was handed over; the excess is the change.
        payments: tenderedRows(payments),
        discountMinor,
        ...saleCustomerFields(customer),
        ...(rxComplete
          ? { prescription: { patientName: rx.patientName.trim(), prescriberName: rx.prescriberName.trim(), prescriptionNumber: rx.prescriptionNumber.trim() } }
          : {}),
        // The card is what earns and redeems; the server re-checks both.
        ...(loyaltyMember ? { loyaltyMembershipId: loyaltyMember.id, redeemPoints: redeeming } : {}),
        note: hasOutOfStockLine ? note.trim() : '',
      }),
    onSuccess: (sale) => {
      toast.success(`${sale.saleNumber} completed`, {
        description: sale.changeMinor > 0 ? `Change due: ${formatMoney(sale.changeMinor, currency)}` : undefined,
      });
      reset();
      setMobilePanel(null);
      setReceiptFor(sale._id);
      void queryClient.invalidateQueries({ queryKey: ['pharmacy'] });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Could not complete the sale');
      void queryClient.invalidateQueries({ queryKey: ['pharmacy', 'medicines'] });
    },
  });

  const canComplete = cart.length > 0 && discountValid && outOfStockNoteValid && payments.isSettled && !complete.isPending;

  return (
    <div className="grid h-full min-w-0 gap-4 bg-muted/20 p-3 pb-24 sm:p-4 sm:pb-24 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,20rem)_minmax(20rem,22rem)] xl:overflow-hidden xl:p-5">
      {/* ------------------------------------------------------ search */}
      <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="space-y-2.5 border-b bg-card px-3 py-3 sm:px-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Medicines</CardTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">Search, scan, then choose a quantity</p>
            </div>
            <Badge variant="secondary" className="shrink-0">{results?.meta.total ?? 0} found</Badge>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              className="pl-8"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              onKeyDown={async (event) => {
                if (event.key !== 'Enter') return;
                const value = term.trim();
                // A membership card scanned into the search box attaches the
                // member rather than looking for a medicine that does not exist.
                if (loyaltyAvailable && isLoyaltyCardCode(value) && (await attachCard(value))) setTerm('');
              }}
              placeholder="Search brand, generic name or scan a barcode…"
              aria-label="Search medicines"
            />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Dosage form</span>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue placeholder="All forms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All forms</SelectItem>
                  {(shelves ?? []).map((row) => <SelectItem key={row.slug} value={row.name}>{row.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Manufacturer</span>
              <Select value={manufacturer} onValueChange={setManufacturer}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue placeholder="All manufacturers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All manufacturers</SelectItem>
                  {(medicineFilters?.manufacturers ?? []).map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <LimitAlert resource="monthlySales" />
        </CardHeader>
        <CardContent ref={medicineListRef} className="scrollbar-thin min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/10 p-2.5 sm:p-3">
          {isLoading ? (
            <LoadingState label="Searching…" />
          ) : (results?.items ?? []).length === 0 ? (
            <EmptyState title="No medicines found" description="Try the generic name, or add it on the Medicines page." />
          ) : (
            <ul className="grid grid-cols-1 md:grid-cols-2  2xl:grid-cols-3  gap-2">
              {(results?.items ?? []).map((medicine) => {
                const sellable = medicine.stock?.sellable ?? 0;
                return (
                 <li
  key={medicine._id}
  className="flex rounded-lg border border-border/70 bg-card p-2 shadow-sm transition-all hover:border-primary/35 hover:shadow-md"
>
  <button
    type="button"
    onClick={() => add(medicine)}
    className="flex w-full min-w-0 flex-col items-start justify-between gap-2 rounded-md px-1 py-0.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
  >
    <div className="w-full min-w-0">
      <p className="whitespace-normal break-words text-sm font-semibold">
        {medicine.name}{' '}
        <span className="text-muted-foreground">
          {medicine.strength}
        </span>{' '}
        {medicine.requiresPrescription && (
          <Badge variant="warning">Rx</Badge>
        )}
      </p>

      <p className="whitespace-normal break-words text-[11px] leading-4 text-muted-foreground">
        {medicine.genericName}
        <br />
        {dosageFormLabel(medicine.dosageForm)}
        <br />
        {medicine.manufacturer}
        <br />
        {`${medicine.packQuantity ?? 1}/pack`}
        <br />
        {medicine.stock?.nearestExpiry
          ? ` · next exp ${formatExpiry(medicine.stock.nearestExpiry)}`
          : ''}
      </p>
    </div>

    <div className="shrink-0 text-right">
      <p className="tabular text-sm font-bold">
        Price: {formatMoney(medicine.sellingPriceMinor, currency)}
      </p>

      <p
        className={cn(
          'text-[11px]',
          sellable <= 0
            ? 'font-medium text-destructive'
            : 'text-muted-foreground'
        )}
      >
        {sellable > 0
          ? `${sellable} in stock`
          : 'Out of stock · note required'}
      </p>
    </div>
  </button>

  <div
    className="mt-1.5 grid grid-cols-1 gap-1 px-1"
    aria-label={`Quick quantities for ${medicine.name}`}
  >
    {QUICK_QUANTITIES.map((quantity) => (
      <Button
        key={quantity}
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2 text-xs hover:border-primary/50 hover:bg-primary/5"
        disabled={
          sellable > 0 &&
          (cart.find(
            (line) => line.medicine._id === medicine._id
          )?.quantity ?? 0) + quantity >
            sellable
        }
        onClick={() => add(medicine, quantity)}
      >
        +{quantity}
      </Button>
    ))}
  </div>
</li>
                );
              })}
            </ul>
          )}
        </CardContent>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-card px-3 py-2 sm:px-4">
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {results?.meta.total
              ? `Showing ${(results.meta.page - 1) * results.meta.limit + 1}–${Math.min(results.meta.page * results.meta.limit, results.meta.total)} of ${results.meta.total}`
              : 'No medicines'}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button type="button" variant="outline" size="icon-sm" disabled={isLoading || medicinePage <= 1} onClick={() => changeMedicinePage(medicinePage - 1)} aria-label="Previous medicine page">
              <ChevronLeft />
            </Button>
            <span className="min-w-16 text-center text-xs font-medium">
              {results ? `${results.meta.page} / ${Math.max(1, results.meta.totalPages)}` : '1 / 1'}
            </span>
            <Button type="button" variant="outline" size="icon-sm" disabled={isLoading || medicinePage >= (results?.meta.totalPages ?? 1)} onClick={() => changeMedicinePage(medicinePage + 1)} aria-label="Next medicine page">
              <ChevronRight />
            </Button>
          </div>
        </div>
      </Card>

      {/* ------------------------------------------- cart + payment workspace */}
      <div className={cn('min-h-0 overflow-hidden bg-background shadow-2xl xl:static xl:inset-auto xl:z-auto xl:col-span-2 xl:grid xl:h-full xl:grid-cols-[minmax(18rem,20rem)_minmax(20rem,22rem)] xl:gap-4 xl:overflow-visible xl:bg-transparent xl:shadow-none', mobilePanel ? 'fixed inset-0 z-50 flex h-[100dvh] flex-col' : 'hidden xl:grid')}>
        <Card className={cn('min-h-24 flex-1 flex-col overflow-hidden rounded-none border-0 shadow-none xl:flex xl:h-full xl:min-h-0 xl:rounded-lg xl:border xl:shadow-sm', mobilePanel === 'payment' ? 'hidden' : 'flex')}>
          <CardHeader className="border-b bg-muted/20 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <CardTitle className="mr-auto flex items-center gap-2 text-base"><ShoppingCart className="h-4 w-4" /> Cart</CardTitle>
              <Badge variant="secondary">{cart.reduce((sum, line) => sum + line.quantity, 0)} item{cart.reduce((sum, line) => sum + line.quantity, 0) === 1 ? '' : 's'}</Badge>
              <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={() => setHeldOpen(true)}><PauseCircle /> Held{heldSales?.length ? ` (${heldSales.length})` : ''}</Button>
              <Button type="button" variant="ghost" size="icon-sm" className="shrink-0 xl:hidden" onClick={() => setMobilePanel(null)} aria-label="Close cart"><X /></Button>
            </div>
          </CardHeader>
          <CardContent className="scrollbar-thin min-h-24 flex-1 space-y-3 overflow-y-auto bg-muted/10 p-3">
          {cart.length === 0 ? (
            <div className="flex h-full min-h-24 flex-col items-center justify-center rounded-lg border border-dashed bg-card/70 p-4 text-center">
              <ShoppingCart className="mb-2 h-7 w-7 text-muted-foreground/60" />
              <p className="text-sm font-medium">Your cart is empty</p>
              <p className="text-xs text-muted-foreground">Select a medicine or scan its barcode.</p>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {cart.map((line) => (
                <li key={line.medicine._id} className="flex items-center gap-1.5 rounded-lg border bg-card p-2 shadow-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {line.medicine.name} {line.medicine.strength}
                    </p>
                    <p className="text-xs text-muted-foreground">{formatMoney(line.medicine.sellingPriceMinor * line.quantity, currency)}</p>
                  </div>
                  <Button variant="outline" size="icon-sm" onClick={() => setQuantity(line.medicine._id, line.quantity - 1)} aria-label="One fewer">
                    <Minus />
                  </Button>
                  <Input className="h-8 w-16 px-1 text-center tabular" inputMode="numeric" min={1} max={10_000} value={line.quantity} onChange={(event) => { const value = event.target.value.replace(/\D/g, ''); if (value) setQuantity(line.medicine._id, Number(value)); }} aria-label={`Quantity of ${line.medicine.name}`} />
                  <Button variant="outline" size="icon-sm" onClick={() => add(line.medicine)} aria-label="One more">
                    <Plus />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setQuantity(line.medicine._id, 0)} aria-label={`Remove ${line.medicine.name}`}>
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {needsRx && (
            <div className="space-y-2 rounded-md border border-warning/50 bg-warning/5 p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <FileText className="h-4 w-4" />
                Prescription details <span className="font-normal text-muted-foreground">(optional)</span>
              </p>
              <p className="text-xs text-muted-foreground">Enter both names to save prescription details, or leave them blank to continue without one.</p>
              <Input value={rx.patientName} maxLength={120} placeholder="Patient name (optional)" onChange={(event) => setRx({ ...rx, patientName: event.target.value })} aria-label="Patient name" />
              <Input value={rx.prescriberName} maxLength={120} placeholder="Prescribing doctor (optional)" onChange={(event) => setRx({ ...rx, prescriberName: event.target.value })} aria-label="Prescriber" />
              <Input value={rx.prescriptionNumber} maxLength={60} placeholder="Prescription number (optional)" onChange={(event) => setRx({ ...rx, prescriptionNumber: event.target.value })} aria-label="Prescription number" />
            </div>
          )}

          </CardContent>
        </Card>

        <Card className={cn('min-h-0 flex-1 flex-col overflow-hidden rounded-none border-0 shadow-none xl:flex xl:h-full xl:rounded-lg xl:border xl:shadow-sm', mobilePanel === 'cart' ? 'hidden' : 'flex')}>
          <CardHeader className="border-b bg-muted/20 px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base"><CreditCard className="h-4 w-4" /> Payment</CardTitle>
              <div className="ml-auto flex items-center gap-2">
                <span className="tabular text-sm font-bold">{formatMoney(total, currency)}</span>
                <Button type="button" variant="ghost" size="icon-sm" className="shrink-0 xl:hidden" onClick={() => setMobilePanel(null)} aria-label="Close payment"><X /></Button>
              </div>
            </div>
          </CardHeader>
          <div className="scrollbar-thin min-h-0 flex-1 space-y-2 overflow-y-auto bg-card px-3 py-2.5 xl:overflow-visible">

          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt>Subtotal</dt>
              <dd className="tabular">{formatMoney(subtotal, currency)}</dd>
            </div>
            {can('sales.discount') && (
              <div className="flex items-center justify-between gap-2">
                <dt>Discount</dt>
                <dd className="flex min-w-0 items-center gap-1">
                  <div className="flex rounded-md border p-0.5"><Button type="button" variant={discountMode === 'amount' ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2" onClick={() => setDiscountMode('amount')}>Amount</Button><Button type="button" variant={discountMode === 'percent' ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2" onClick={() => setDiscountMode('percent')}>%</Button></div>
                  <div className="w-28">{discountMode === 'amount' ? <MoneyInput value={discount} onChange={setDiscount} ariaLabel="Discount amount" /> : <div className="relative"><Input className="h-9 pr-7 text-right tabular" inputMode="decimal" value={discountPercent} onChange={(event) => setDiscountPercent(event.target.value.replace(/[^\d.]/g, '').slice(0, 6))} aria-label="Discount percent" /><span className="pointer-events-none absolute right-2 top-2 text-sm text-muted-foreground">%</span></div>}</div>
                </dd>
              </div>
            )}
            {!discountValid && <p className="text-right text-xs text-destructive">Enter a discount from 0–100%, or no more than the subtotal.</p>}
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

          {hasOutOfStockLine && (
            <div className="space-y-1">
              <Label htmlFor="pharmacy-sale-note" className="text-xs">
                Sale note <span className="text-destructive">(required for out-of-stock sale)</span>
              </Label>
              <Input
                id="pharmacy-sale-note"
                className="h-8"
                value={note}
                maxLength={300}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Why is this out-of-stock sale allowed?"
                aria-invalid={!outOfStockNoteValid}
              />
              {!outOfStockNoteValid && (
                <p className="text-xs text-destructive">Enter at least 3 characters before completing this sale.</p>
              )}
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
            issues={cart.length > 0 ? payments.issues : []}
            currency={currency}
            onAmountChange={payments.setAmount}
            onMethodChange={payments.setMethod}
            onAddRow={payments.addRow}
            onRemoveRow={payments.removeRow}
              compact
            />
          </div>
          <div className="shrink-0 space-y-2 border-t bg-muted/20 p-3">
            <Button size="lg" className="w-full min-w-0 whitespace-normal shadow-md" disabled={!canComplete} loading={complete.isPending} onClick={() => complete.mutate()}>
              Complete sale · {formatMoney(total, currency)}
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button className="w-full" variant="outline" onClick={reset} disabled={cart.length === 0}>Clear</Button>
              <Button className="w-full" variant="outline" disabled={cart.length === 0 || !discountValid} loading={hold.isPending} onClick={() => hold.mutate()}><PauseCircle /> Hold</Button>
            </div>
          </div>
        </Card>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur xl:hidden">
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" className="h-12 min-w-0 px-3" onClick={() => setMobilePanel('cart')}>
            <ShoppingCart />
            <span className="truncate">Cart ({cart.reduce((sum, line) => sum + line.quantity, 0)})</span>
          </Button>
          <Button className="h-12 min-w-0 px-3" onClick={() => setMobilePanel('payment')}>
            <CreditCard />
            <span className="truncate">Payment · {formatMoney(total, currency)}</span>
          </Button>
        </div>
      </div>

      {/* Opened only by a completed sale, so it prints itself - no dialog, no
          printer picker. The sale is already saved; printing cannot undo it. */}
      <PharmacyReceiptDialog saleId={receiptFor} onClose={() => setReceiptFor(null)} onNewSale={() => setReceiptFor(null)} autoPrint />

      <LoyaltyCardDialog open={cardDialogOpen} onOpenChange={setCardDialogOpen} onSubmit={(code) => attachCard(code)} />
      {heldOpen && <PharmacyHeldSalesDialog currency={currency} onClose={() => setHeldOpen(false)} onResumed={(sale) => void restore(sale)} />}
    </div>
  );
}
