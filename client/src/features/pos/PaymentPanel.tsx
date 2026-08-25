import { Plus, Trash2, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
  allocatedMinor: number;
  remainingMinor: number;
  changeMinor: number;
  issues: string[];
  currency: string;
  onAmountChange: (id: string, amountMinor: number | null) => void;
  onMethodChange: (id: string, method: PaymentMethod) => void;
  onAddRow: (method: PaymentMethod) => void;
  onRemoveRow: (id: string) => void;
}

/**
 * Tender entry, single or split.
 *
 * A single row behaves as the familiar "amount tendered" field. Adding a method
 * turns it into a split: the new row's amount is deducted from the first
 * (normally Cash) row, so the allocation always adds up to the total.
 */
export function PaymentPanel({
  rows,
  availableMethods,
  totalMinor,
  allocatedMinor,
  remainingMinor,
  changeMinor,
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
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1.5 text-xs">
          <Wallet className="h-3.5 w-3.5" />
          {isSplit ? `Split payment (${rows.length} methods)` : 'Payment'}
        </Label>
        {remainingMinor > 0 && <Badge variant="warning">Remaining {formatMoney(remainingMinor, currency)}</Badge>}
        {changeMinor > 0 && <Badge variant="success">Change {formatMoney(changeMinor, currency)}</Badge>}
      </div>

      <div className="space-y-1.5">
        {rows.map((row, index) => (
          <div key={row.id} className="flex items-center gap-1.5">
            <Select
              value={row.method}
              onValueChange={(value) => onMethodChange(row.id, value as PaymentMethod)}
            >
              <SelectTrigger className="h-9 w-[104px] shrink-0">
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

            <MoneyInput
              value={row.amountMinor}
              onChange={(amount) => onAmountChange(row.id, amount)}
              className="flex-1"
              ariaLabel={`${PAYMENT_METHOD_LABELS[row.method]} amount`}
            />

            {rows.length > 1 && (
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
            )}
            {rows.length === 1 && <span className="w-8 shrink-0" />}

            {index === 0 && isSplit && (
              <span className="sr-only">Adjusts automatically as other methods are added</span>
            )}
          </div>
        ))}
      </div>

      {unusedMethods.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {unusedMethods.map((method) => (
            <Button
              key={method}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onAddRow(method)}
              disabled={totalMinor <= 0}
            >
              <Plus className="h-3 w-3" />
              {PAYMENT_METHOD_LABELS[method]}
            </Button>
          ))}
        </div>
      )}

      <dl className="space-y-1 rounded-md border bg-muted/40 p-2.5 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Total</dt>
          <dd className="tabular font-medium">{formatMoney(totalMinor, currency)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Tendered</dt>
          <dd className={cn('tabular font-medium', allocatedMinor < totalMinor && 'text-destructive')}>
            {formatMoney(allocatedMinor, currency)}
          </dd>
        </div>
        <div className="flex justify-between border-t pt-1">
          <dt className="font-medium">{remainingMinor > 0 ? 'Remaining' : 'Change'}</dt>
          <dd
            className={cn(
              'tabular font-semibold',
              remainingMinor > 0 ? 'text-destructive' : changeMinor > 0 ? 'text-success' : '',
            )}
          >
            {formatMoney(remainingMinor > 0 ? remainingMinor : changeMinor, currency)}
          </dd>
        </div>
      </dl>

      {issues.length > 0 && (
        <ul className="list-inside list-disc rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
          {issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
