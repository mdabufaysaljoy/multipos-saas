import { AlertTriangle, Lock, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
          <div key={line.variantId} className={cn('p-3', hasIssue && 'bg-destructive/5')}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium leading-tight">{line.productName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {line.variantName} · <span className="font-mono">{line.sku}</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{line.availableStock} in stock</p>
              </div>

              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(line.variantId)}
                aria-label={`Remove ${line.productName}`}
              >
                <Trash2 />
              </Button>
            </div>

            <div className="mt-2.5 flex flex-wrap items-end justify-between gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Quantity
                </label>
                <QuantityInput
                  value={line.quantity}
                  onChange={(quantity) => onQuantityChange(line.variantId, quantity)}
                  max={line.availableStock}
                  ariaLabel={`Quantity for ${line.productName}`}
                />
              </div>

              <div className="space-y-1">
                <label className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Unit price
                  {!canChangePrice && <Lock className="h-2.5 w-2.5" />}
                </label>
                {canChangePrice ? (
                  <MoneyInput
                    value={line.unitPriceMinor}
                    onChange={(price) => onPriceChange(line.variantId, price)}
                    className="w-28"
                    ariaLabel={`Unit price for ${line.productName}`}
                  />
                ) : (
                  // Without the permission the price is not even editable, and
                  // the server would reject an override regardless.
                  <div className="tabular flex h-9 w-28 items-center justify-end rounded-md border border-input bg-muted px-3 text-sm">
                    {formatMoney(line.unitPriceMinor, currency)}
                  </div>
                )}
              </div>

              <div className="ml-auto space-y-1 text-right">
                <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Total</label>
                <p className="tabular text-base font-semibold leading-9">
                  {lineTotal === null ? '—' : formatMoney(lineTotal, currency)}
                </p>
              </div>
            </div>

            {isOverridden && (
              <div className="mt-2">
                <Badge variant="warning">
                  Price changed from {formatMoney(line.listPriceMinor, currency)}
                </Badge>
              </div>
            )}

            {lineIssues.map((issue, index) => (
              <p key={index} className="mt-2 flex items-center gap-1.5 text-xs font-medium text-destructive">
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
