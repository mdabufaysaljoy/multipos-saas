import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Repeat2, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { pharmacyApi } from '@/api/pharmacy';
import { useDebounced } from '@/components/SearchInput';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { PaymentPanel } from '@/features/payments/PaymentPanel';
import { tenderedRows } from '@/features/payments/paymentMath';
import { usePayments } from '@/features/payments/usePayments';
import { formatMoney } from '@/lib/money';
import { tendersFromConfig, type TenderOption } from '@/types/domain';
import type { Medicine, PharmacySale } from '@/types/pharmacy';

/** A Pharmacy exchange: returned dispensing credit applied to a new sale. */
export function PharmacyExchangeDialog({
  sale,
  currency,
  posConfig,
  onClose,
  onDone,
}: {
  sale: PharmacySale;
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
  const [replacement, setReplacement] = React.useState<{ medicine: Medicine; quantity: number }[]>([]);
  const idempotencyKey = React.useMemo(
    () => `ph-ex-${sale._id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    [sale._id],
  );

  const returning = sale.items
    .map((line) => ({ line, quantity: quantities[line._id] ?? 0 }))
    .filter((entry) => entry.quantity > 0);
  const shareOfCharged = (gross: number) =>
    sale.subtotalMinor > 0 ? Math.floor((gross * sale.totalMinor) / sale.subtotalMinor) : gross;
  const creditMinor = returning.reduce(
    (sum, entry) => sum + shareOfCharged(entry.line.unitPriceMinor * entry.quantity),
    0,
  );
  const replacementMinor = replacement.reduce(
    (sum, row) => sum + row.medicine.sellingPriceMinor * row.quantity,
    0,
  );
  const extraPayableMinor = Math.max(0, replacementMinor - creditMinor);
  const cheaper = returning.length > 0 && replacement.length > 0 && replacementMinor < creditMinor;
  const payments = usePayments(extraPayableMinor);

  const { data: found } = useQuery({
    queryKey: ['pharmacy', 'medicines', 'exchange', search],
    queryFn: () => pharmacyApi.medicines({ limit: 20, activeOnly: 'true', search }),
    enabled: search.length > 0,
  });

  const addReplacement = (medicine: Medicine) => {
    setReplacement((current) =>
      current.some((row) => row.medicine._id === medicine._id)
        ? current.map((row) =>
            row.medicine._id === medicine._id ? { ...row, quantity: row.quantity + 1 } : row,
          )
        : [...current, { medicine, quantity: 1 }],
    );
    setTerm('');
  };

  const submit = useMutation({
    mutationFn: () =>
      pharmacyApi.createExchange(sale._id, {
        items: returning.map((entry) => ({ saleItemId: entry.line._id, quantity: entry.quantity, restock })),
        replacement: {
          items: replacement.map((row) => ({ medicineId: row.medicine._id, quantity: row.quantity })),
          payments: extraPayableMinor > 0 ? tenderedRows(payments) : [],
        },
        reason,
        idempotencyKey,
      }),
    onSuccess: (result) => {
      toast.success(result.replayed ? 'That exchange was already recorded' : `${result.returnNumber} exchanged`, {
        description: result.exchange
          ? `Replacement ${result.exchange.saleNumber} · ${formatMoney(result.exchange.extraPayableMinor, currency)} collected`
          : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ['pharmacy'] });
      if (result.exchange) onDone(result.exchange.saleId);
      else onClose();
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return toast.error('Could not complete the exchange');
      const [, detail] = Object.entries(error.fieldErrors)[0] ?? [];
      toast.error(detail ?? error.message);
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
          <DialogTitle className="flex items-center gap-2"><Repeat2 className="h-4 w-4" /> Exchange against {sale.saleNumber}</DialogTitle>
          <DialogDescription>
            Select returned medicines and their replacements. A replacement must be equal or higher in value.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="space-y-1.5">
            <Label>Returning</Label>
            <ul className="divide-y rounded-md border">
              {sale.items.map((line) => {
                const left = line.quantity - (line.returnedQuantity ?? 0);
                return (
                  <li key={line._id} className="flex items-center gap-3 p-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{line.nameSnapshot} {line.strengthSnapshot}</p>
                      <p className="text-xs text-muted-foreground">{line.dosageFormSnapshot} · {formatMoney(line.unitPriceMinor, currency)} · {left > 0 ? `${left} left` : 'fully returned'}</p>
                    </div>
                    <Input
                      type="number" min={0} max={left} disabled={left <= 0}
                      className="h-8 w-24 text-right" value={quantities[line._id] ?? ''}
                      aria-label={`Quantity of ${line.nameSnapshot} to return`}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setQuantities((current) => ({ ...current, [line._id]: Number.isFinite(value) ? Math.min(left, Math.max(0, Math.trunc(value))) : 0 }));
                      }}
                    />
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between pt-1">
              <Label htmlFor="ph-ex-restock" className="text-sm font-normal">Return medicines to their original batches</Label>
              <Switch id="ph-ex-restock" checked={restock} onCheckedChange={setRestock} />
            </div>
          </section>

          <section className="space-y-1.5">
            <Label>Replacement medicines</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-8" value={term} onChange={(event) => setTerm(event.target.value)} placeholder="Search or scan a replacement medicine" />
            </div>
            {search.length > 0 && (found?.items.length ?? 0) > 0 && (
              <ul className="max-h-40 divide-y overflow-y-auto rounded-md border">
                {found?.items.map((medicine) => (
                  <li key={medicine._id}>
                    <button type="button" className="flex w-full items-center justify-between gap-3 px-2.5 py-2 text-left text-sm hover:bg-muted/50" onClick={() => addReplacement(medicine)}>
                      <span className="min-w-0 truncate">{medicine.name} {medicine.strength} · {medicine.dosageForm}</span>
                      <span className="shrink-0 font-medium tabular">{formatMoney(medicine.sellingPriceMinor, currency)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {replacement.length > 0 && (
              <ul className="divide-y rounded-md border">
                {replacement.map((row) => (
                  <li key={row.medicine._id} className="flex items-center gap-2 p-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{row.medicine.name} {row.medicine.strength}</p>
                      <p className="text-xs text-muted-foreground">{formatMoney(row.medicine.sellingPriceMinor * row.quantity, currency)}</p>
                    </div>
                    <Input type="number" min={1} className="h-8 w-24 text-right" value={row.quantity} aria-label={`Quantity of ${row.medicine.name}`} onChange={(event) => {
                      const quantity = Math.max(1, Math.trunc(Number(event.target.value) || 1));
                      setReplacement((current) => current.map((entry) => entry.medicine._id === row.medicine._id ? { ...entry, quantity } : entry));
                    }} />
                    <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${row.medicine.name}`} onClick={() => setReplacement((current) => current.filter((entry) => entry.medicine._id !== row.medicine._id))}><Trash2 /></Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between"><span>Returned medicine credit</span><span className="tabular">{formatMoney(creditMinor, currency)}</span></div>
            <div className="flex justify-between"><span>Replacement total</span><span className="tabular">{formatMoney(replacementMinor, currency)}</span></div>
            <div className="flex justify-between font-semibold"><span>Customer pays</span><span className="tabular">{formatMoney(extraPayableMinor, currency)}</span></div>
            {cheaper && <p className="pt-1 text-destructive">Choose replacements equal to or above the returned value. Use a return when money must be refunded.</p>}
          </section>

          {extraPayableMinor > 0 && (
            <PaymentPanel rows={payments.rows} availableMethods={tendersFromConfig(posConfig)} totalMinor={extraPayableMinor} hasCash={payments.hasCash} remainingPayableMinor={payments.remainingPayableMinor} changeMinor={payments.changeMinor} dueMinor={payments.dueMinor} cashTyped={payments.cashTyped} issues={payments.issues} currency={currency} onAmountChange={payments.setAmount} onMethodChange={payments.setMethod} onAddRow={payments.addRow} onRemoveRow={payments.removeRow} />
          )}

          <div className="space-y-1.5">
            <Label htmlFor="ph-ex-note">Exchange note (required)</Label>
            <Input id="ph-ex-note" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for this exchange" maxLength={300} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={blocked} loading={submit.isPending} onClick={() => submit.mutate()}>
            {extraPayableMinor > 0 ? `Take ${formatMoney(extraPayableMinor, currency)} and exchange` : 'Complete exchange'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
