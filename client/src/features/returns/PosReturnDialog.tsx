import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/api/client';
import { formatMoney } from '@/lib/money';
import { tendersFromConfig, type TenderOption } from '@/types/domain';

/** One line of the sale, as this dialog needs it - whatever the vertical calls it. */
export interface ReturnableSaleLine {
  _id: string;
  label: string;
  detail?: string;
  quantity: number;
  returnedQuantity?: number;
  unitPriceMinor: number;
}

interface PosReturnDialogProps {
  saleNumber: string;
  lines: ReturnableSaleLine[];
  currency: string;
  posConfig?: { tenders?: TenderOption[]; paymentMethods?: string[] };
  /** Sends the return. The caller knows which vertical's endpoint that is. */
  onSubmit: (input: { items: { saleItemId: string; quantity: number; restock: boolean }[]; reason: string; refundMethod: string }) => Promise<unknown>;
  onClose: () => void;
  /** Query keys to refresh once the return is recorded. */
  invalidate: string[];
  /**
   * Whether the goods can go back into stock. False for a restaurant, which
   * keeps none: the switch would be a question with only one answer.
   */
  restockable?: boolean;
}

/**
 * Taking goods back against a sale, in any POS vertical.
 *
 * Only what is left to return can be chosen: a line already returned is shown
 * as such and cannot be picked again. The refund shown here is an estimate from
 * the sale's own prices - the server works out what was actually paid, sharing
 * out any discount the whole sale had, and that is what goes back.
 */
export function PosReturnDialog({ saleNumber, lines, currency, posConfig, onSubmit, onClose, invalidate, restockable = true }: PosReturnDialogProps) {
  const queryClient = useQueryClient();
  const [quantities, setQuantities] = React.useState<Record<string, number>>({});
  const [restock, setRestock] = React.useState(restockable);
  const [reason, setReason] = React.useState('');
  const tenders = tendersFromConfig(posConfig);
  const [refundMethod, setRefundMethod] = React.useState(tenders[0]?.key ?? 'cash');

  const remainingOf = (line: ReturnableSaleLine) => line.quantity - (line.returnedQuantity ?? 0);
  const chosen = lines
    .map((line) => ({ line, quantity: quantities[line._id] ?? 0 }))
    .filter((entry) => entry.quantity > 0);
  const estimateMinor = chosen.reduce((sum, entry) => sum + entry.line.unitPriceMinor * entry.quantity, 0);

  const submit = useMutation({
    mutationFn: () =>
      onSubmit({
        items: chosen.map((entry) => ({ saleItemId: entry.line._id, quantity: entry.quantity, restock })),
        reason: reason.trim(),
        refundMethod,
      }),
    onSuccess: () => {
      toast.success(restockable ? 'Return recorded' : 'Refund recorded', {
        description: restockable ? (restock ? 'The goods are back in stock.' : 'The goods were not put back in stock.') : 'The money goes back; a kitchen keeps no stock.',
      });
      invalidate.forEach((key) => void queryClient.invalidateQueries({ queryKey: [key] }));
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the return'),
  });

  const ready = chosen.length > 0 && reason.trim().length >= 3;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Return against {saleNumber}</DialogTitle>
          <DialogDescription>Choose what is coming back. The refund is worked out from what was actually paid.</DialogDescription>
        </DialogHeader>

        <ul className="divide-y text-sm">
          {lines.map((line) => {
            const remaining = remainingOf(line);
            return (
              <li key={line._id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{line.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {line.detail ? `${line.detail} · ` : ''}
                    {formatMoney(line.unitPriceMinor, currency)} each ·{' '}
                    {remaining > 0 ? `${remaining} of ${line.quantity} left to return` : 'fully returned'}
                  </p>
                </div>
                <Input
                  type="number"
                  min={0}
                  max={remaining}
                  disabled={remaining <= 0}
                  value={quantities[line._id] ?? ''}
                  placeholder="0"
                  aria-label={`Quantity of ${line.label} to return`}
                  className="w-20"
                  onChange={(event) => {
                    const value = Math.max(0, Math.min(remaining, Number(event.target.value) || 0));
                    setQuantities((current) => ({ ...current, [line._id]: value }));
                  }}
                />
              </li>
            );
          })}
        </ul>

        <div className="space-y-3">
          {restockable && (
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label>Put the goods back in stock</Label>
                <p className="text-xs text-muted-foreground">Switch off for damaged, opened or expired goods.</p>
              </div>
              <Switch checked={restock} onCheckedChange={setRestock} />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="refund-method">Refund on</Label>
            <select
              id="refund-method"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={refundMethod}
              onChange={(event) => setRefundMethod(event.target.value)}
            >
              {tenders.map((tender) => (
                <option key={tender.key} value={tender.key}>
                  {tender.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="return-reason">Why is it coming back?</Label>
            <Input id="return-reason" value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} placeholder="Customer changed their mind" />
          </div>

          {chosen.length > 0 && (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              About <span className="tabular font-semibold">{formatMoney(estimateMinor, currency)}</span> goes back
              <span className="text-muted-foreground"> — less any discount this sale had</span>
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready} loading={submit.isPending} onClick={() => submit.mutate()}>
            <Undo2 />
            Record return
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
