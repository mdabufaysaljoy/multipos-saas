import * as React from 'react';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeftRight, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { QuantityInput } from '@/components/QuantityInput';
import { useQuery } from '@tanstack/react-query';
import { productApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { PaymentPanel } from '@/features/payments/PaymentPanel';
import { usePayments } from '@/features/payments/usePayments';
import { useBarcodeScanner } from '@/features/pos/useBarcodeScanner';
import type { TenderOption, PosVariant } from '@/types/domain';

export interface ReplacementLine {
  variant: PosVariant;
  quantity: number | null;
}

export interface ExchangeState {
  lines: ReplacementLine[];
  payments: ReturnType<typeof usePayments>;
  replacementSubtotalMinor: number;
  replacementTotalMinor: number;
  extraPayableMinor: number;
  issues: string[];
}

interface ExchangePanelProps {
  refundMinor: number;
  currency: string;
  tax: { enabled: boolean; inclusive: boolean; rateBasisPoints: number } | undefined;
  availableMethods: TenderOption[];
  onChange: (state: ExchangeState) => void;
}

/**
 * The replacement side of an exchange: what the customer takes instead, and
 * how any extra is paid. Prices shown are the catalogue prices of the exact
 * variants picked; the server prices everything again and applies the same rule.
 */
export function ExchangePanel({ refundMinor, currency, tax, availableMethods, onChange }: ExchangePanelProps) {
  const [lines, setLines] = React.useState<ReplacementLine[]>([]);
  const [term, setTerm] = React.useState('');
  const debounced = useDebounced(term, 250);

  const { data: results = [], isFetching } = useQuery({
    queryKey: ['pos-search', 'exchange', debounced],
    queryFn: () => productApi.posSearch({ q: debounced, limit: 8 }),
    enabled: debounced.trim().length > 0,
  });

  const add = React.useCallback((variant: PosVariant) => {
    if (variant.stock <= 0) {
      toast.error('Out of stock', { description: `${variant.productName} (${variant.variantName}) has no stock.` });
      return;
    }
    setLines((prev) => {
      const existing = prev.find((line) => line.variant.variantId === variant.variantId);
      if (existing) {
        return prev.map((line) =>
          line.variant.variantId === variant.variantId ? { ...line, quantity: Math.min((line.quantity ?? 0) + 1, variant.stock) } : line,
        );
      }
      return [...prev, { variant, quantity: 1 }];
    });
    setTerm('');
  }, []);

  // The same handheld scanner as the till: an exact barcode picks the exact variant.
  useBarcodeScanner({
    onScan: async (code) => {
      try {
        const matches = await productApi.posSearch({ q: code, limit: 5 });
        const exact = matches.find((match) => match.barcode === code);
        if (!exact) {
          toast.error('Unknown barcode', { description: `No product matches "${code}".` });
          return;
        }
        add(exact);
      } catch {
        toast.error('Could not look up that barcode');
      }
    },
  });

  const replacementSubtotalMinor = lines.reduce((sum, line) => sum + line.variant.sellingPriceMinor * (line.quantity ?? 0), 0);
  const taxMinor = tax?.enabled && !tax.inclusive ? Math.round((replacementSubtotalMinor * tax.rateBasisPoints) / 10_000) : 0;
  const replacementTotalMinor = replacementSubtotalMinor + taxMinor;
  const cheaper = lines.length > 0 && replacementSubtotalMinor < refundMinor;
  const extraPayableMinor = lines.length > 0 && !cheaper ? Math.max(replacementTotalMinor - refundMinor, 0) : 0;
  const payments = usePayments(extraPayableMinor);

  const issues: string[] = [];
  if (lines.length === 0) issues.push('Select the replacement product');
  if (lines.some((line) => !line.quantity || line.quantity <= 0)) issues.push('Enter a quantity for every replacement');
  if (lines.some((line) => (line.quantity ?? 0) > line.variant.stock)) issues.push('A replacement quantity is more than the stock');
  if (cheaper) {
    issues.push("Exchange product cannot be cheaper than the returned item's refund value. Please select a product with an equal or higher price.");
  }
  if (extraPayableMinor > 0 && !payments.isSettled) issues.push(...payments.issues);

  // Report upward on every change; the page owns submission.
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const issuesKey = issues.join('|');
  React.useEffect(() => {
    onChangeRef.current({ lines, payments, replacementSubtotalMinor, replacementTotalMinor, extraPayableMinor, issues: issuesKey ? issuesKey.split('|') : [] });
    // `payments` changes identity every render; its meaningful parts are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, replacementSubtotalMinor, replacementTotalMinor, extraPayableMinor, issuesKey, payments.rows, payments.cashTenderedMinor]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <ArrowLeftRight className="h-4 w-4" />
        Exchange for
      </div>

      <div className="space-y-1.5">
        <SearchInput value={term} onChange={setTerm} placeholder="Search product, SKU or barcode…" />
        {debounced && (
          <ul className="scrollbar-thin max-h-48 divide-y overflow-y-auto rounded-md border">
            {isFetching && results.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">Searching…</li>}
            {!isFetching && results.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">No matching products</li>}
            {results.map((variant) => (
              <li key={variant.variantId}>
                <button
                  type="button"
                  onClick={() => add(variant)}
                  disabled={variant.stock <= 0}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{variant.productName}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {variant.variantName} · <span className="font-mono">{variant.sku}</span> · {variant.stock} in stock
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-sm font-semibold">{formatMoney(variant.sellingPriceMinor, currency)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {lines.length > 0 && (
        <ul className="divide-y rounded-md border">
          {lines.map((line) => (
            <li key={line.variant.variantId} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{line.variant.productName}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {line.variant.variantName} · {formatMoney(line.variant.sellingPriceMinor, currency)}
                </span>
              </span>
              <QuantityInput
                value={line.quantity}
                max={line.variant.stock}
                onChange={(quantity) =>
                  setLines((prev) => prev.map((row) => (row.variant.variantId === line.variant.variantId ? { ...row, quantity } : row)))
                }
                ariaLabel={`Quantity of ${line.variant.productName}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setLines((prev) => prev.filter((row) => row.variant.variantId !== line.variant.variantId))}
                aria-label={`Remove ${line.variant.productName}`}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <dl className="space-y-0.5 rounded-md border bg-muted/40 px-3 py-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Refund value</dt>
          <dd className="tabular">{formatMoney(refundMinor, currency)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Replacement{taxMinor > 0 ? ' (incl. VAT)' : ''}</dt>
          <dd className={cn('tabular', cheaper && 'text-destructive')}>{formatMoney(replacementTotalMinor, currency)}</dd>
        </div>
        <div className="flex justify-between border-t pt-1 font-semibold">
          <dt>Extra payable</dt>
          <dd className="tabular">{formatMoney(extraPayableMinor, currency)}</dd>
        </div>
      </dl>

      {cheaper && (
        <p className="flex items-start gap-1.5 text-xs font-medium text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Exchange product cannot be cheaper than the returned item's refund value. Please select a product with an equal or higher price.
        </p>
      )}

      {extraPayableMinor > 0 ? (
        <PaymentPanel
          rows={payments.rows}
          availableMethods={availableMethods}
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
      ) : (
        lines.length > 0 && !cheaper && <p className="text-xs text-muted-foreground">Equal value — no extra payment needed.</p>
      )}
    </div>
  );
}
