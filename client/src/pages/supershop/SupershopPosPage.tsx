import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CreditCard, Minus, Plus, ScanBarcode, Scale, Trash2 } from 'lucide-react';
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
import { loyaltyApi } from '@/api/endpoints';
import type { LoyaltyLookup } from '@/types/domain';
import { PaymentPanel } from '@/features/payments/PaymentPanel';
import { tenderedRows } from '@/features/payments/paymentMath';
import { usePayments } from '@/features/payments/usePayments';
import { ShopReceiptDialog } from '@/features/supershop/ShopReceiptDialog';
import { ApiError } from '@/api/client';
import { storeApi } from '@/api/endpoints';
import { supershopApi } from '@/api/supershop';
import { formatMoney } from '@/lib/money';
import { formatQuantity, gramsToKgText, lineAmount, parseKgToGrams } from '@/lib/supershop';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import type { ShopProduct } from '@/types/supershop';
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

  const { data: results, isLoading } = useQuery({
    queryKey: ['supershop', 'products', 'pos', search],
    queryFn: () => supershopApi.products({ limit: 30, activeOnly: 'true', ...(search ? { search } : {}) }),
    enabled: search.length > 0,
  });

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
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not complete the sale'),
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
          <LimitAlert resource="monthlySales" />
        </CardHeader>
        <CardContent className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          {!search ? (
            <EmptyState title="Ready to scan" description="Scanned items go straight into the basket. Weighed goods ask for the weight." />
          ) : isLoading ? (
            <LoadingState label="Searching…" />
          ) : (results?.items ?? []).length === 0 ? (
            <EmptyState title="Nothing found" description="Try another name or barcode." />
          ) : (
            <ul className="divide-y">
              {(results?.items ?? []).map((product) => {
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
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Basket · {cart.length} line(s)</CardTitle>
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
          <Button className="flex-1" disabled={!canComplete} loading={complete.isPending} onClick={() => complete.mutate()}>
            Complete sale · {formatMoney(total, currency)}
          </Button>
        </div>
      </Card>

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
