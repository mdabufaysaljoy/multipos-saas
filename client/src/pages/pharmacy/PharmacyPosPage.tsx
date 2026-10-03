import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CreditCard, FileText, Minus, Plus, Search, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
import { LoyaltyCardDialog } from '@/features/loyalty/LoyaltyCardDialog';
import { LoyaltyStrip } from '@/features/loyalty/LoyaltyStrip';
import { isLoyaltyCardCode, maxRedeemablePoints, pointsForSpend } from '@/features/loyalty/loyaltyMath';
import { useLoyaltyAccess } from '@/features/loyalty/useLoyaltyAccess';
import { CategoryFilter } from '@/features/catalogue/CategoryFilter';
import { ApiError } from '@/api/client';
import { loyaltyApi, storeApi } from '@/api/endpoints';
import { pharmacyApi } from '@/api/pharmacy';
import { pharmacyCategoriesApi } from '@/api/posCategories';
import { formatMoney } from '@/lib/money';
import { dosageFormLabel, formatExpiry } from '@/lib/pharmacy';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import type { Medicine } from '@/types/pharmacy';
import type { LoyaltyLookup } from '@/types/domain';
import { tendersFromConfig } from '@/types/domain';

interface CartLine {
  medicine: Medicine;
  quantity: number;
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
 * never expired) and refuses a prescription-only medicine without a prescription.
 */
export function PharmacyPosPage() {
  const { activeStore, can } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const queryClient = useQueryClient();

  const [term, setTerm] = React.useState('');
  const search = useDebounced(term);
  const [cart, setCart] = React.useState<CartLine[]>([]);
  const [discount, setDiscount] = React.useState<number | null>(0);
  const [discountMode, setDiscountMode] = React.useState<'amount' | 'percent'>('amount');
  const [discountPercent, setDiscountPercent] = React.useState('');
  const [rx, setRx] = React.useState(EMPTY_RX);
  const [customer, setCustomer] = React.useState<SelectedCustomer | null>(null);
  // Only a scanned CARD earns or redeems - never a customer or a phone number.
  const [loyaltyMember, setLoyaltyMember] = React.useState<LoyaltyLookup | null>(null);
  const [redeemPoints, setRedeemPoints] = React.useState<number | null>(null);
  const [cardDialogOpen, setCardDialogOpen] = React.useState(false);
  const loyaltyAccess = useLoyaltyAccess();
  // A till with this permission may dispense units the system thinks are gone.
  // The server still refuses expired stock, and refuses entirely when there is
  // no unexpired batch to record the units against.
  const canSellOutOfStock = can('sales.sellOutOfStock');
  const [receiptFor, setReceiptFor] = React.useState<string | null>(null);

  // The categories this pharmacy groups its shelves by, in the owner's order
  // and without the ones they hid.
  const { data: shelves } = useQuery({ queryKey: ['pharmacy', 'categories', 'filter'], queryFn: () => pharmacyCategoriesApi.list() });
  const { data: medicineFilters } = useQuery({ queryKey: ['pharmacy', 'medicine-filters'], queryFn: pharmacyApi.medicineFilters });
  const [category, setCategory] = React.useState('all');
  const [manufacturer, setManufacturer] = React.useState('all');

  const { data: results, isLoading } = useQuery({
    queryKey: ['pharmacy', 'medicines', 'pos', search, category, manufacturer],
    queryFn: () =>
      pharmacyApi.medicines({ limit: 30, activeOnly: 'true', ...(search ? { search } : {}), ...(category !== 'all' ? { category } : {}), ...(manufacturer !== 'all' ? { manufacturer } : {}) }),
  });

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

  const add = (medicine: Medicine, amount = 1) => {
    const sellable = medicine.stock?.sellable ?? 0;
    const existing = cart.find((line) => line.medicine._id === medicine._id);
    const target = (existing?.quantity ?? 0) + amount;
    // Out of stock entirely is what the permission covers; having SOME but not
    // enough is refused for everyone, here and on the server.
    if (target > sellable && !(sellable <= 0 && canSellOutOfStock)) {
      toast.error(sellable <= 0 ? `${medicine.name} is out of stock` : `Only ${sellable} of ${medicine.name} in stock`);
      return;
    }
    setCart(
      existing
        ? cart.map((line) => (line.medicine._id === medicine._id ? { ...line, quantity: target } : line))
        : [...cart, { medicine, quantity: amount }],
    );
  };

  const setQuantity = (id: string, quantity: number) => {
    const line = cart.find((entry) => entry.medicine._id === id);
    if (!line) return;
    const clean = Math.min(Math.max(Math.trunc(quantity), 0), 10_000);
    const sellable = line.medicine.stock?.sellable ?? 0;
    if (clean > sellable && !(sellable <= 0 && canSellOutOfStock)) { toast.error(`Only ${sellable} of ${line.medicine.name} in stock`); return; }
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
    setCustomer(null);
    removeCard();
    payments.reset();
  };

  const complete = useMutation({
    mutationFn: () =>
      pharmacyApi.createSale({
        items: cart.map((line) => ({ medicineId: line.medicine._id, quantity: line.quantity })),
        // Cash carries what was handed over; the excess is the change.
        payments: tenderedRows(payments),
        discountMinor,
        ...saleCustomerFields(customer),
        ...(needsRx
          ? { prescription: { patientName: rx.patientName.trim(), prescriberName: rx.prescriberName.trim(), prescriptionNumber: rx.prescriptionNumber.trim() } }
          : {}),
        // The card is what earns and redeems; the server re-checks both.
        ...(loyaltyMember ? { loyaltyMembershipId: loyaltyMember.id, redeemPoints: redeeming } : {}),
      }),
    onSuccess: (sale) => {
      toast.success(`${sale.saleNumber} completed`, {
        description: sale.changeMinor > 0 ? `Change due: ${formatMoney(sale.changeMinor, currency)}` : undefined,
      });
      reset();
      setReceiptFor(sale._id);
      void queryClient.invalidateQueries({ queryKey: ['pharmacy'] });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Could not complete the sale');
      void queryClient.invalidateQueries({ queryKey: ['pharmacy', 'medicines'] });
    },
  });

  const canComplete = cart.length > 0 && discountValid && (!needsRx || rxComplete) && payments.isSettled && !complete.isPending;

  return (
    <div className="grid h-full gap-4 p-4 lg:grid-cols-[1fr_24rem] lg:p-6">
      {/* ------------------------------------------------------ search */}
      <Card className="flex min-h-0 flex-col">
        <CardHeader className="space-y-3 pb-2">
          <CardTitle className="text-base">Medicines</CardTitle>
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
          <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Dosage form</span>
            <CategoryFilter categories={(shelves ?? []).map((row) => row.name)} value={category} onChange={setCategory} />
          </div>
          <div className="max-w-xs space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Manufacturer</span>
            <Select value={manufacturer} onValueChange={setManufacturer}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="All manufacturers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All manufacturers</SelectItem>
                {(medicineFilters?.manufacturers ?? []).map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <LimitAlert resource="monthlySales" />
        </CardHeader>
        <CardContent className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <LoadingState label="Searching…" />
          ) : (results?.items ?? []).length === 0 ? (
            <EmptyState title="No medicines found" description="Try the generic name, or add it on the Medicines page." />
          ) : (
            <ul className="divide-y">
              {(results?.items ?? []).map((medicine) => {
                const sellable = medicine.stock?.sellable ?? 0;
                const blocked = sellable <= 0 && !canSellOutOfStock;
                return (
                  <li key={medicine._id} className="py-2.5">
                    <button
                      type="button"
                      disabled={blocked}
                      onClick={() => add(medicine)}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 rounded px-1 py-1 text-left transition-colors hover:bg-muted/50',
                        blocked && 'cursor-not-allowed opacity-50',
                      )}
                    >
                      <div className="min-w-0">
                        <p className="font-medium">
                          {medicine.name} <span className="text-muted-foreground">{medicine.strength}</span>{' '}
                          {medicine.requiresPrescription && <Badge variant="warning">Rx</Badge>}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[medicine.genericName, dosageFormLabel(medicine.dosageForm), medicine.manufacturer].filter(Boolean).join(' · ')}
                          {` · ${medicine.packQuantity ?? 1}/pack`}
                          {medicine.stock?.nearestExpiry ? ` · next exp ${formatExpiry(medicine.stock.nearestExpiry)}` : ''}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="tabular font-semibold">{formatMoney(medicine.sellingPriceMinor, currency)}</p>
                        <p className={cn('text-xs', sellable <= 0 ? 'text-destructive' : 'text-muted-foreground')}>
                          {sellable > 0 ? `${sellable} in stock` : canSellOutOfStock ? 'Out of stock · sell anyway' : 'Out of stock'}
                        </p>
                      </div>
                    </button>
                    <div className="mt-1 flex flex-wrap items-center gap-1 px-1" aria-label={`Quick quantities for ${medicine.name}`}>
                      <span className="mr-1 text-[11px] text-muted-foreground">Add</span>
                      {QUICK_QUANTITIES.map((quantity) => (
                        <Button key={quantity} type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={blocked || (sellable > 0 && (cart.find((line) => line.medicine._id === medicine._id)?.quantity ?? 0) + quantity > sellable)} onClick={() => add(medicine, quantity)}>{quantity}</Button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* -------------------------------------------------------- cart */}
      <Card className="flex min-h-0 flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Sale</CardTitle>
        </CardHeader>
        <CardContent className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto pb-2">
          {cart.length === 0 ? (
            <p className="text-sm text-muted-foreground">Pick medicines on the left.</p>
          ) : (
            <ul className="divide-y">
              {cart.map((line) => (
                <li key={line.medicine._id} className="flex items-center gap-2 py-2">
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
                Prescription required
              </p>
              <Input value={rx.patientName} maxLength={120} placeholder="Patient name" onChange={(event) => setRx({ ...rx, patientName: event.target.value })} aria-label="Patient name" />
              <Input value={rx.prescriberName} maxLength={120} placeholder="Prescribing doctor" onChange={(event) => setRx({ ...rx, prescriberName: event.target.value })} aria-label="Prescriber" />
              <Input value={rx.prescriptionNumber} maxLength={60} placeholder="Prescription number (optional)" onChange={(event) => setRx({ ...rx, prescriptionNumber: event.target.value })} aria-label="Prescription number" />
            </div>
          )}

        </CardContent>
        <div className="shrink-0 space-y-3 border-t bg-card px-4 py-3">

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
        </div>
        <div className="flex gap-2 border-t p-3">
          <Button variant="outline" onClick={reset} disabled={cart.length === 0}>
            Clear
          </Button>
          <Button className="flex-1" disabled={!canComplete} loading={complete.isPending} onClick={() => complete.mutate()}>
            Complete sale · {formatMoney(total, currency)}
          </Button>
        </div>
      </Card>

      {/* Opened only by a completed sale, so it prints itself - no dialog, no
          printer picker. The sale is already saved; printing cannot undo it. */}
      <PharmacyReceiptDialog saleId={receiptFor} onClose={() => setReceiptFor(null)} onNewSale={() => setReceiptFor(null)} autoPrint />

      <LoyaltyCardDialog open={cardDialogOpen} onOpenChange={setCardDialogOpen} onSubmit={(code) => attachCard(code)} />
    </div>
  );
}
