import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { MenuItem } from '@/types/restaurant';

/** What the till chose: enough to send the line, and to show it before it goes. */
export interface PickedMenuItem {
  variantId?: string;
  variantName: string;
  addOnOptionIds: string[];
  addOnNames: string[];
  /** The preview price of one, worked out the same way the server will. */
  unitPriceMinor: number;
}

/** A dish needs asking about when it has sizes, or any extras to offer. */
export const needsChoosing = (item: MenuItem) =>
  (item.variants ?? []).length > 0 || (item.addOnGroups ?? []).length > 0;

/**
 * Choosing the size and extras for one dish.
 *
 * The price shown here is a PREVIEW. The server prices the line again from the
 * menu when it is added, so a stale screen can never decide what is charged -
 * it only decides which variant and which extras were asked for.
 */
export function MenuItemPicker({
  item,
  currency,
  onClose,
  onPick,
}: {
  item: MenuItem | null;
  currency: string;
  onClose: () => void;
  onPick: (picked: PickedMenuItem) => void;
}) {
  const variants = React.useMemo(() => (item?.variants ?? []).filter((variant) => variant.isAvailable), [item]);
  const groups = React.useMemo(() => item?.addOnGroups ?? [], [item]);

  const [variantId, setVariantId] = React.useState<string | null>(null);
  const [chosen, setChosen] = React.useState<string[]>([]);

  React.useEffect(() => {
    // A single size is not a question, so it is preselected.
    setVariantId(variants.length > 0 ? variants[0]._id : null);
    setChosen([]);
  }, [item, variants]);

  if (!item) return null;

  const variant = variants.find((v) => v._id === variantId) ?? null;
  const allOptions = groups.flatMap((group) => group.options.map((option) => ({ group, option })));
  const picked = allOptions.filter((entry) => chosen.includes(entry.option._id));
  const unitPriceMinor = (variant ? variant.priceMinor : item.priceMinor) + picked.reduce((sum, entry) => sum + entry.option.priceMinor, 0);

  // Exactly the rules the server enforces, so the till never offers a line it
  // will refuse: every group between its own min and max, and a size chosen
  // whenever the dish has any.
  const unsatisfied = groups.find((group) => {
    const taken = group.options.filter((option) => chosen.includes(option._id)).length;
    return taken < group.minSelect || taken > group.maxSelect;
  });
  const valid = (variants.length === 0 || Boolean(variant)) && !unsatisfied;

  const toggle = (optionId: string, maxSelect: number, groupOptionIds: string[]) => {
    setChosen((current) => {
      if (current.includes(optionId)) return current.filter((id) => id !== optionId);
      const inGroup = current.filter((id) => groupOptionIds.includes(id));
      // A group that only takes one behaves like a choice, not a checklist.
      if (maxSelect === 1) return [...current.filter((id) => !groupOptionIds.includes(id)), optionId];
      if (inGroup.length >= maxSelect) return current;
      return [...current, optionId];
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-md">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
          <DialogDescription>
            {variants.length > 0 ? 'Choose a size, and any extras.' : 'Choose any extras.'}
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-thin -mx-1 max-h-[58vh] space-y-4 overflow-y-auto px-1">
          {variants.length > 0 && (
            <div className="space-y-1.5">
              <Label>Size</Label>
              <div className="grid grid-cols-2 gap-2">
                {variants.map((option) => (
                  <button
                    key={option._id}
                    type="button"
                    onClick={() => setVariantId(option._id)}
                    className={cn(
                      'rounded-md border p-2 text-left text-sm transition-colors hover:bg-accent',
                      option._id === variantId && 'ring-2 ring-primary',
                    )}
                  >
                    <span className="block font-medium">{option.name}</span>
                    <span className="tabular block text-xs text-muted-foreground">{formatMoney(option.priceMinor, currency)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {groups.map((group) => {
            const groupOptionIds = group.options.map((option) => option._id);
            return (
              <div key={group._id} className="space-y-1.5">
                <Label>
                  {group.name}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    {group.minSelect > 0 ? `choose ${group.minSelect}` : 'optional'}
                    {group.maxSelect > 1 ? `, up to ${group.maxSelect}` : ''}
                  </span>
                </Label>
                <div className="grid grid-cols-2 gap-2">
                  {group.options
                    .filter((option) => option.isAvailable)
                    .map((option) => (
                      <button
                        key={option._id}
                        type="button"
                        onClick={() => toggle(option._id, group.maxSelect, groupOptionIds)}
                        className={cn(
                          'rounded-md border p-2 text-left text-sm transition-colors hover:bg-accent',
                          chosen.includes(option._id) && 'ring-2 ring-primary',
                        )}
                      >
                        <span className="block font-medium">{option.name}</span>
                        <span className="tabular block text-xs text-muted-foreground">+ {formatMoney(option.priceMinor, currency)}</span>
                      </button>
                    ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Its own row rather than a footer child: DialogFooter reverses its
            children on a narrow screen, which put the price below the buttons. */}
        <div className="flex items-baseline justify-between border-t pt-3">
          <span className="text-sm text-muted-foreground">Each</span>
          <span className="tabular text-xl font-bold">{formatMoney(unitPriceMinor, currency)}</span>
        </div>

        <DialogFooter>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!valid}
              onClick={() =>
                onPick({
                  ...(variant ? { variantId: variant._id } : {}),
                  variantName: variant?.name ?? '',
                  addOnOptionIds: picked.map((entry) => entry.option._id),
                  addOnNames: picked.map((entry) => entry.option.name),
                  unitPriceMinor,
                })
              }
            >
              Add
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
