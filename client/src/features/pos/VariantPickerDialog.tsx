import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { PosVariant } from '@/types/domain';
import type { PosProductGroup } from './groupVariants';

interface VariantPickerDialogProps {
  group: PosProductGroup | null;
  currency: string;
  /** UX only: the server checks the permission again when the sale is created. */
  canSellOutOfStock?: boolean;
  onSelect: (variant: PosVariant) => void;
  onClose: () => void;
}

/**
 * Shown when a product has more than one sellable variant. A single-variant
 * product skips this entirely and goes straight into the cart.
 */
export function VariantPickerDialog({ group, currency, canSellOutOfStock = false, onSelect, onClose }: VariantPickerDialogProps) {
  return (
    <Dialog open={Boolean(group)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{group?.productName}</DialogTitle>
          <DialogDescription>
            Choose the variant to add to the cart.
            {group?.brand ? ` ${group.brand}.` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-thin -mx-1 max-h-[55vh] space-y-1.5 overflow-y-auto px-1">
          {group?.variants.map((variant) => {
            const outOfStock = variant.stock <= 0;
            const lowStock = !outOfStock && variant.lowStockThreshold > 0 && variant.stock <= variant.lowStockThreshold;

            return (
              <button
                key={variant.variantId}
                type="button"
                disabled={outOfStock && !canSellOutOfStock}
                onClick={() => onSelect(variant)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
                  outOfStock && !canSellOutOfStock
                    ? 'cursor-not-allowed opacity-55'
                    : 'hover:border-primary hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{variant.variantName}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{variant.sku}</p>
                </div>

                <span className="tabular shrink-0 font-semibold">
                  {formatMoney(variant.sellingPriceMinor, currency)}
                </span>

                {outOfStock && canSellOutOfStock ? (
                  <span className="flex shrink-0 flex-col items-end gap-0.5">
                    <Badge variant="destructive">Out</Badge>
                    <span className="text-[10px] font-semibold text-warning">Sell anyway</span>
                  </span>
                ) : outOfStock ? (
                  <Badge variant="destructive">Out</Badge>
                ) : lowStock ? (
                  <Badge variant="warning">{variant.stock} left</Badge>
                ) : (
                  <Badge variant="secondary">{variant.stock}</Badge>
                )}
              </button>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
