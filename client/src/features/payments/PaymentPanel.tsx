import { Plus, Trash2, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyInput } from '@/components/MoneyInput';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@/types/domain';
import type { PaymentRow } from './usePayments';

interface PaymentPanelProps {
  rows: PaymentRow[];
  availableMethods: PaymentMethod[];
  totalMinor: number;
  hasCash: boolean;
  remainingPayableMinor: number;
  changeMinor: number;
  dueMinor: number;
  cashTyped: boolean;
  issues: string[];
  currency: string;
  onAmountChange: (id: string, amountMinor: number | null) => void;
  onMethodChange: (id: string, method: PaymentMethod) => void;
  onAddRow: (method: PaymentMethod) => void;
  onRemoveRow: (id: string) => void;
}

/**
 * How the sale is paid.
 *
 * Cash takes what the customer actually hands over; change and anything still
 * due are worked out live. Other methods take the amount paid by them. Without
 * cash, the first method covers whatever the others leave.
 */
export function PaymentPanel({
  rows,
  availableMethods,
  totalMinor,
  hasCash,
  remainingPayableMinor,
  changeMinor,
  dueMinor,
  cashTyped,
  issues,
  currency,
  onAmountChange,
  onMethodChange,
  onAddRow,
  onRemoveRow,
}: PaymentPanelProps) {
  const usedMethods = new Set(rows.map((row) => row.method));
  const unusedMethods = availableMethods.filter((method) => !usedMethods.has(method));
  const isSplit = rows.length > 1;

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-xs">
        <Wallet className="h-3.5 w-3.5" />
        {isSplit ? `Split payment (${rows.length} methods)` : 'Payment'}
      </Label>

      <div className="space-y-1.5">
        {rows.map((row, index) => {
          const isCash = row.method === 'cash';
          const derived = !hasCash && index === 0;
          return (
            <div key={row.id} className="flex items-center gap-1.5">
              <Select value={row.method} onValueChange={(value) => onMethodChange(row.id, value as PaymentMethod)}>
                <SelectTrigger className="h-8 w-[108px] shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableMethods
                    .filter((method) => method === row.method || !usedMethods.has(method))
                    .map((method) => (
                      <SelectItem key={method} value={method}>
                        {PAYMENT_METHOD_LABELS[method]}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>

              {derived ? (
                // No cash in this sale: the first method pays whatever the others leave.
                <div
                  className="tabular flex h-8 min-w-0 flex-1 items-center justify-end rounded-md border border-input bg-muted px-3 text-sm"
                  aria-label={`${PAYMENT_METHOD_LABELS[row.method]} pays`}
                >
                  {isSplit && <span className="mr-auto truncate text-xs text-muted-foreground">rest</span>}
                  {formatMoney(remainingPayableMinor, currency)}
                </div>
              ) : (
                <div className="relative min-w-0 flex-1">
                  <MoneyInput
                    value={row.amountMinor}
                    onChange={(amount) => onAmountChange(row.id, amount)}
                    className="[&_input]:h-8"
                    ariaLabel={isCash ? 'Cash received from the customer' : `${PAYMENT_METHOD_LABELS[row.method]} amount`}
                  />
                </div>
              )}

              {index > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => onRemoveRow(row.id)}
                  aria-label={`Remove ${PAYMENT_METHOD_LABELS[row.method]}`}
                >
                  <Trash2 />
                </Button>
              ) : (
                isSplit && <span className="w-8 shrink-0" aria-hidden />
              )}
            </div>
          );
        })}
      </div>

      {unusedMethods.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-muted-foreground">Split with:</span>
          {unusedMethods.map((method) => (
            <Button
              key={method}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onAddRow(method)}
              disabled={totalMinor <= 0}
            >
              <Plus className="h-3 w-3" />
              {PAYMENT_METHOD_LABELS[method]}
            </Button>
          ))}
        </div>
      )}

      {hasCash && totalMinor > 0 && (
        // Cash due, and what happens to the cash handed over: change back, or still owed.
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs">
          <dt className="text-muted-foreground">Cash due</dt>
          <dd className="tabular text-right font-medium">{formatMoney(remainingPayableMinor, currency)}</dd>
          {dueMinor > 0 ? (
            <>
              <dt className="font-semibold text-destructive">Remaining due</dt>
              <dd className="tabular text-right font-semibold text-destructive">{formatMoney(dueMinor, currency)}</dd>
            </>
          ) : (
            <>
              <dt className={cn('font-semibold', changeMinor > 0 ? 'text-success' : 'text-foreground')}>Change</dt>
              <dd className={cn('tabular text-right font-semibold', changeMinor > 0 ? 'text-success' : 'text-foreground')}>
                {formatMoney(changeMinor, currency)}
              </dd>
            </>
          )}
          {!cashTyped && dueMinor === 0 && (
            <dd className="col-span-2 text-[11px] text-muted-foreground">Exact cash. Type the amount received to work out change.</dd>
          )}
        </dl>
      )}

      {issues.length > 0 && (
        <ul className="list-inside list-disc rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
          {issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
