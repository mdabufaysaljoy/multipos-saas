import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Minus, Plus, Search, Trash2 } from 'lucide-react';
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
import { PharmacyReceiptDialog } from '@/features/pharmacy/PharmacyReceiptDialog';
import { ApiError } from '@/api/client';
import { pharmacyApi } from '@/api/pharmacy';
import { formatMoney } from '@/lib/money';
import { DOSAGE_FORM_LABELS, formatExpiry } from '@/lib/pharmacy';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import type { Medicine } from '@/types/pharmacy';

const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'bkash', label: 'bKash' },
  { value: 'nagad', label: 'Nagad' },
  { value: 'card', label: 'Card' },
  { value: 'bank', label: 'Bank' },
  { value: 'other', label: 'Other' },
];

interface CartLine {
  medicine: Medicine;
  quantity: number;
}

const EMPTY_RX = { patientName: '', prescriberName: '', prescriptionNumber: '' };

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
  const [method, setMethod] = React.useState('cash');
  const [tendered, setTendered] = React.useState<number | null>(null);
  const [rx, setRx] = React.useState(EMPTY_RX);
  const [customer, setCustomer] = React.useState<SelectedCustomer | null>(null);
  const [receiptFor, setReceiptFor] = React.useState<string | null>(null);

  const { data: results, isLoading } = useQuery({
    queryKey: ['pharmacy', 'medicines', 'pos', search],
    queryFn: () => pharmacyApi.medicines({ limit: 30, activeOnly: 'true', ...(search ? { search } : {}) }),
  });

  const subtotal = cart.reduce((sum, line) => sum + line.medicine.sellingPriceMinor * line.quantity, 0);
  const discountMinor = Math.min(discount ?? 0, subtotal);
  const total = subtotal - discountMinor;
  const paid = tendered ?? total;
  const needsRx = cart.some((line) => line.medicine.requiresPrescription);
  const rxComplete = rx.patientName.trim().length >= 2 && rx.prescriberName.trim().length >= 2;

  const add = (medicine: Medicine) => {
    const sellable = medicine.stock?.sellable ?? 0;
    const existing = cart.find((line) => line.medicine._id === medicine._id);
    if ((existing?.quantity ?? 0) >= sellable) {
      toast.error(sellable === 0 ? `${medicine.name} is out of stock` : `Only ${sellable} of ${medicine.name} in stock`);
      return;
    }
    setCart(
      existing
        ? cart.map((line) => (line.medicine._id === medicine._id ? { ...line, quantity: line.quantity + 1 } : line))
        : [...cart, { medicine, quantity: 1 }],
    );
  };

  const setQuantity = (id: string, quantity: number) =>
    setCart(cart.flatMap((line) => (line.medicine._id !== id ? [line] : quantity <= 0 ? [] : [{ ...line, quantity }])));

  const reset = () => {
    setCart([]);
    setDiscount(0);
    setTendered(null);
    setRx(EMPTY_RX);
    setMethod('cash');
    setCustomer(null);
  };

  const complete = useMutation({
    mutationFn: () =>
      pharmacyApi.createSale({
        items: cart.map((line) => ({ medicineId: line.medicine._id, quantity: line.quantity })),
        payments: [{ method, amountMinor: paid }],
        discountMinor,
        ...saleCustomerFields(customer),
        ...(needsRx
          ? { prescription: { patientName: rx.patientName.trim(), prescriberName: rx.prescriberName.trim(), prescriptionNumber: rx.prescriptionNumber.trim() } }
          : {}),
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

  const canComplete = cart.length > 0 && (!needsRx || rxComplete) && paid >= total && !complete.isPending;

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
              placeholder="Search brand, generic name or scan a barcode…"
              aria-label="Search medicines"
            />
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
                return (
                  <li key={medicine._id}>
                    <button
                      type="button"
                      disabled={sellable === 0}
                      onClick={() => add(medicine)}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 px-1 py-2.5 text-left transition-colors hover:bg-muted/50',
                        sellable === 0 && 'cursor-not-allowed opacity-50',
                      )}
                    >
                      <div className="min-w-0">
                        <p className="font-medium">
                          {medicine.name} <span className="text-muted-foreground">{medicine.strength}</span>{' '}
                          {medicine.requiresPrescription && <Badge variant="warning">Rx</Badge>}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {[medicine.genericName, DOSAGE_FORM_LABELS[medicine.dosageForm]].filter(Boolean).join(' · ')}
                          {medicine.stock?.nearestExpiry ? ` · next exp ${formatExpiry(medicine.stock.nearestExpiry)}` : ''}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="tabular font-semibold">{formatMoney(medicine.sellingPriceMinor, currency)}</p>
                        <p className={cn('text-xs', sellable === 0 ? 'text-destructive' : 'text-muted-foreground')}>
                          {sellable === 0 ? 'Out of stock' : `${sellable} in stock`}
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

      {/* -------------------------------------------------------- cart */}
      <Card className="flex min-h-0 flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Sale</CardTitle>
        </CardHeader>
        <CardContent className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto">
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
                  <span className="w-8 text-center tabular">{line.quantity}</span>
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

          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt>Subtotal</dt>
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
            <div className="flex justify-between text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular">{formatMoney(total, currency)}</dd>
            </div>
          </dl>

          <CustomerPicker value={customer} onChange={setCustomer} canCreate={can('customers.create')} />

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Paid by</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Amount received</Label>
              <MoneyInput value={tendered} onChange={setTendered} placeholder={(total / 100).toFixed(2)} ariaLabel="Amount received" />
            </div>
          </div>
          {paid > total && method === 'cash' && <p className="text-sm">Change: {formatMoney(paid - total, currency)}</p>}
          {paid < total && cart.length > 0 && <p className="text-sm text-destructive">{formatMoney(total - paid, currency)} still due</p>}
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

      {/* Opened only by a completed sale, so it prints itself - no dialog, no
          printer picker. The sale is already saved; printing cannot undo it. */}
      <PharmacyReceiptDialog saleId={receiptFor} onClose={() => setReceiptFor(null)} onNewSale={() => setReceiptFor(null)} autoPrint />
    </div>
  );
}
