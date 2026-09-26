import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Repeat2, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useDebounced } from '@/components/SearchInput';
import { PaymentPanel } from '@/features/payments/PaymentPanel';
import { tenderedRows } from '@/features/payments/paymentMath';
import { usePayments } from '@/features/payments/usePayments';
import { ApiError } from '@/api/client';
import { supershopApi } from '@/api/supershop';
import { formatMoney } from '@/lib/money';
import { formatQuantity, lineAmount } from '@/lib/supershop';
import { tendersFromConfig, type TenderOption } from '@/types/domain';
import type { ShopProduct, ShopSale } from '@/types/supershop';

/**
 * Exchanging goods against a Super Shop sale.
 *
 * Two halves: what comes back, and what goes out. The figures here are an
 * ESTIMATE the cashier can read - the server re-values the returned goods from
 * the original sale (sharing out any discount it had) and the replacement from
 * today's catalogue, and those are the numbers that count. The rule it enforces
 * is the one shown here: a replacement may not be worth less than what came
 * back, because a shop does not pay cash for trading down.
 */
export function ShopExchangeDialog({
  sale,
  currency,
  posConfig,
  onClose,
  onDone,
}: {
  sale: ShopSale;
  currency: string;
  posConfig?: { tenders?: TenderOption[]; paymentMethods?: string[] };
  onClose: () => void;
  onDone: (replacementSaleId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [quantities, setQuantities] = React.useState<Record<string, number>>({});
  const [restock, setRestock] = React.useState(true);
  const [reason, setReason] = React.useState('');
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term);
  const [replacement, setReplacement] = React.useState<{ product: ShopProduct; quantity: number }[]>([]);

  // One key per opening of this dialog: a double click sends the same key, and
  // the server answers with the exchange it already made rather than a second one.
  const idempotencyKey = React.useMemo(() => `ex-${sale._id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, [sale._id]);

  const remainingOf = (line: ShopSale['items'][number]) => line.quantity - (line.returnedQuantity ?? 0);
  const returning = sale.items
    .map((line) => ({ line, quantity: quantities[line._id] ?? 0 }))
    .filter((entry) => entry.quantity > 0);

  // The till's estimate of what the returned goods are worth: their own price,
  // less their share of any discount the whole sale had.
  const shareOfDiscount = (gross: number) =>
    sale.discountMinor > 0 && sale.subtotalMinor > 0 ? Math.floor((gross * (sale.subtotalMinor - sale.discountMinor)) / sale.subtotalMinor) : gross;
  const creditMinor = returning.reduce(
    (sum, entry) => sum + shareOfDiscount(lineAmount(entry.line.unitPriceMinor, entry.quantity, entry.line.unitType)),
    0,
  );
  const replacementMinor = replacement.reduce((sum, row) => sum + lineAmount(row.product.priceMinor, row.quantity, row.product.unitType), 0);
  const extraPayableMinor = Math.max(0, replacementMinor - creditMinor);
  const cheaper = replacement.length > 0 && returning.length > 0 && replacementMinor < creditMinor;

  const payments = usePayments(extraPayableMinor);

  const { data: found } = useQuery({
    queryKey: ['supershop', 'products', 'exchange', search],
    queryFn: () => supershopApi.products({ limit: 20, activeOnly: 'true', ...(search ? { search } : {}) }),
    enabled: search.length > 0,
  });

  const addReplacement = (product: ShopProduct) =>
    setReplacement((current) =>
      current.some((row) => row.product._id === product._id)
        ? current.map((row) => (row.product._id === product._id ? { ...row, quantity: row.quantity + 1 } : row))
        : [...current, { product, quantity: 1 }],
    );

  const submit = useMutation({
    mutationFn: () =>
      supershopApi.createExchange(sale._id, {
        items: returning.map((entry) => ({ saleItemId: entry.line._id, quantity: entry.quantity, restock })),
        replacement: {
          items: replacement.map((row) => ({ productId: row.product._id, quantity: row.quantity })),
          // Nothing to pay means nothing to send.
          payments: extraPayableMinor > 0 ? tenderedRows(payments) : [],
        },
        reason,
        idempotencyKey,
      }),
    onSuccess: (result) => {
      toast.success(result.replayed ? 'That exchange was already recorded' : `${result.returnNumber} exchanged`, {
        description: result.exchange ? `Replacement ${result.exchange.saleNumber} · ${formatMoney(result.exchange.extraPayableMinor, currency)} collected` : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ['supershop'] });
      if (result.exchange) onDone(result.exchange.saleId);
      onClose();
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) {
        toast.error('Could not complete the exchange');
        return;
      }
      const [, detail] = Object.entries(err.fieldErrors)[0] ?? [];
      toast.error(detail ?? err.message);
    },
  });

  const blocked =
    returning.length === 0 ||
    replacement.length === 0 ||
    reason.trim().length < 3 ||
    cheaper ||
    (extraPayableMinor > 0 && !payments.isSettled);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat2 className="h-4 w-4" /> Exchange against {sale.saleNumber}
          </DialogTitle>
          <DialogDescription>
            Choose what comes back and what goes out. The replacement cannot be worth less than the returned goods.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* ---- what comes back ---- */}
          <section className="space-y-1.5">
            <Label>Returning</Label>
            <ul className="divide-y rounded-md border">
              {sale.items.map((line) => {
                const left = remainingOf(line);
                return (
                  <li key={line._id} className="flex items-center gap-3 p-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{line.nameSnapshot}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatMoney(line.unitPriceMinor, currency)}
                        {line.unitType === 'weight' ? '/kg' : ''} · {left > 0 ? `${formatQuantity(left, line.unitType)} left` : 'fully returned'}
                      </p>
                    </div>
                    <Input
                      type="number"
                      min={0}
                      max={left}
                      disabled={left <= 0}
                      className="h-8 w-24 text-right"
                      aria-label={`Quantity of ${line.nameSnapshot} to return`}
                      value={quantities[line._id] ?? ''}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setQuantities((current) => ({ ...current, [line._id]: Number.isFinite(next) ? Math.min(Math.max(0, Math.trunc(next)), left) : 0 }));
                      }}
                    />
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between pt-1">
              <Label htmlFor="ex-restock" className="text-sm font-normal">
                Put the returned goods back in stock
              </Label>
              <Switch id="ex-restock" checked={restock} onCheckedChange={setRestock} />
            </div>
          </section>

          {/* ---- what goes out ---- */}
          <section className="space-y-1.5">
            <Label>Replacement</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-8" value={term} onChange={(event) => setTerm(event.target.value)} placeholder="Search or scan the replacement" aria-label="Find a replacement product" />
            </div>
            {search.length > 0 && (found?.items ?? []).length > 0 && (
              <ul className="max-h-40 divide-y overflow-y-auto rounded-md border">
                {(found?.items ?? []).map((product) => (
                  <li key={product._id}>
                    <button type="button" className="flex w-full items-center justify-between gap-3 px-2.5 py-2 text-left text-sm hover:bg-muted/50" onClick={() => addReplacement(product)}>
                      <span className="truncate">{product.name}</span>
                      <span className="tabular shrink-0 font-medium">
                        {formatMoney(product.priceMinor, currency)}
                        {product.unitType === 'weight' ? '/kg' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {replacement.length > 0 && (
              <ul className="divide-y rounded-md border">
                {replacement.map((row) => (
                  <li key={row.product._id} className="flex items-center gap-2 p-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{row.product.name}</p>
                      <p className="text-xs text-muted-foreground">{formatMoney(lineAmount(row.product.priceMinor, row.quantity, row.product.unitType), currency)}</p>
                    </div>
                    <Input
                      type="number"
                      min={1}
                      className="h-8 w-24 text-right"
                      aria-label={`Quantity of ${row.product.name}`}
                      value={row.quantity}
                      onChange={(event) => {
                        const next = Math.max(1, Math.trunc(Number(event.target.value) || 1));
                        setReplacement((current) => current.map((entry) => (entry.product._id === row.product._id ? { ...entry, quantity: next } : entry)));
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${row.product.name}`}
                      onClick={() => setReplacement((current) => current.filter((entry) => entry.product._id !== row.product._id))}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ---- the difference ---- */}
          <section className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between">
              <span>Returned goods are worth</span>
              <span className="tabular">{formatMoney(creditMinor, currency)}</span>
            </div>
            <div className="flex justify-between">
              <span>Replacement</span>
              <span className="tabular">{formatMoney(replacementMinor, currency)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>Customer pays</span>
              <span className="tabular">{formatMoney(extraPayableMinor, currency)}</span>
            </div>
            {cheaper && (
              <p className="pt-1 text-destructive">
                The replacement is worth less than what came back. Choose something of equal or higher value, or take a refund instead.
              </p>
            )}
          </section>

          {extraPayableMinor > 0 && (
            <PaymentPanel
              rows={payments.rows}
              availableMethods={tendersFromConfig(posConfig)}
              totalMinor={extraPayableMinor}
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
          )}

          <div className="space-y-1.5">
            <Label htmlFor="ex-reason">Reason</Label>
            <Input id="ex-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Wrong size, changed their mind…" maxLength={300} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={blocked} loading={submit.isPending} onClick={() => submit.mutate()}>
            {extraPayableMinor > 0 ? `Take ${formatMoney(extraPayableMinor, currency)} and exchange` : 'Exchange'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
