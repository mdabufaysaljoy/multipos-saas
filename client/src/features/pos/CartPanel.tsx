import { AlertTriangle, Lock, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/states';
import { MoneyInput } from '@/components/MoneyInput';
import { QuantityInput } from '@/components/QuantityInput';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { CartLine, CartValidationIssue } from './useCart';

interface CartPanelProps {
  lines: CartLine[];
  issues: CartValidationIssue[];
  currency: string;
  canChangePrice: boolean;
  onQuantityChange: (variantId: string, quantity: number | null) => void;
  onPriceChange: (variantId: string, priceMinor: number | null) => void;
  onRemove: (variantId: string) => void;
}

export function CartPanel({
  lines,
  issues,
  currency,
  canChangePrice,
  onQuantityChange,
  onPriceChange,
  onRemove,
}: CartPanelProps) {
  if (lines.length === 0) {
    return (
      <EmptyState
        title="Cart is empty"
        description="Search for a product on the left, or scan a barcode, to start a sale."
      />
    );
  }

  const issuesFor = (variantId: string) => issues.filter((issue) => issue.variantId === variantId);

  return (
    <div className="divide-y">
      {lines.map((line) => {
        const lineIssues = issuesFor(line.variantId);
        const hasIssue = lineIssues.length > 0;
        const isOverridden = line.unitPriceMinor !== null && line.unitPriceMinor !== line.listPriceMinor;
        const lineTotal =
          line.quantity !== null && line.unitPriceMinor !== null ? line.unitPriceMinor * line.quantity : null;

        return (
          <div key={line.variantId} className={cn('px-3 py-2', hasIssue && 'bg-destructive/5')}>
            {/* Line 1: what it is, and what it costs. */}
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium leading-5">{line.productName}</p>
                <p className="truncate text-xs leading-4 text-muted-foreground">
                  {line.variantName} · <span className="font-mono">{line.sku}</span> · {line.availableStock} in stock
                </p>
              </div>
              <p className="tabular shrink-0 pt-0.5 text-sm font-semibold" aria-label={`Line total for ${line.productName}`}>
                {lineTotal === null ? '—' : formatMoney(lineTotal, currency)}
              </p>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-mr-1 -mt-0.5 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(line.variantId)}
                aria-label={`Remove ${line.productName}`}
              >
                <Trash2 />
              </Button>
            </div>

            {/* Line 2: quantity x unit price. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <QuantityInput
                value={line.quantity}
                onChange={(quantity) => onQuantityChange(line.variantId, quantity)}
                max={line.outOfStockSale ? undefined : line.availableStock}
                ariaLabel={`Quantity for ${line.productName}`}
              />
              <span className="text-xs text-muted-foreground" aria-hidden>
                ×
              </span>
              {canChangePrice ? (
                <MoneyInput
                  value={line.unitPriceMinor}
                  onChange={(price) => onPriceChange(line.variantId, price)}
                  className="w-28 [&_input]:h-8"
                  ariaLabel={`Unit price for ${line.productName}`}
                />
              ) : (
                // Without the permission the price is not even editable, and
                // the server would reject an override regardless.
                <div
                  className="tabular flex h-8 w-28 items-center justify-end gap-1 rounded-md border border-input bg-muted px-2.5 text-sm"
                  title="You do not have permission to change prices"
                >
                  <Lock className="h-3 w-3 text-muted-foreground" aria-hidden />
                  {formatMoney(line.unitPriceMinor, currency)}
                </div>
              )}
              {isOverridden && (
                <span className="text-xs font-medium text-warning">was {formatMoney(line.listPriceMinor, currency)}</span>
              )}
            </div>

            {line.outOfStockSale && (
              <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-warning">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Out-of-stock sale
              </p>
            )}

            {lineIssues.map((issue, index) => (
              <p key={index} className="mt-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {issue.message}
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}
