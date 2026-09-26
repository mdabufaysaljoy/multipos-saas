import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { PauseCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, LoadingState } from '@/components/states';
import { ApiError } from '@/api/client';
import { supershopApi } from '@/api/supershop';
import { formatMoney } from '@/lib/money';
import type { ShopResumedSale } from '@/types/supershop';

/**
 * The baskets this branch has put aside.
 *
 * Only this branch's: the server scopes the list to the till's own store, so
 * one shop can never pick up another's. Resuming CLAIMS a basket - it is removed
 * in the same step - so two tills cannot both take the same one, and a held sale
 * cannot be completed twice.
 */
export function HeldSalesDialog({
  currency,
  onClose,
  onResumed,
}: {
  currency: string;
  onClose: () => void;
  onResumed: (sale: ShopResumedSale) => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['supershop', 'held-sales'], queryFn: () => supershopApi.heldSales() });

  const resume = useMutation({
    mutationFn: (id: string) => supershopApi.resumeHold(id),
    onSuccess: (sale) => {
      onResumed(sale);
      void queryClient.invalidateQueries({ queryKey: ['supershop', 'held-sales'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not open that held sale'),
  });

  const discard = useMutation({
    mutationFn: (id: string) => supershopApi.removeHold(id),
    onSuccess: (result) => {
      toast.success(`${result.holdNumber} discarded`);
      void queryClient.invalidateQueries({ queryKey: ['supershop', 'held-sales'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not discard that held sale'),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PauseCircle className="h-4 w-4" /> Held sales
          </DialogTitle>
          <DialogDescription>
            Baskets put aside at this branch. Opening one brings it back to the till and takes it off this list; prices are
            re-read from the catalogue.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <LoadingState label="Loading held sales…" />
        ) : (data ?? []).length === 0 ? (
          <EmptyState title="Nothing is on hold" description="Hold a basket from the till and it will wait here." />
        ) : (
          <ul className="divide-y rounded-md border">
            {(data ?? []).map((row) => (
              <li key={row._id} className="flex items-center gap-2 p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {row.holdNumber}
                    {row.label ? ` · ${row.label}` : ''}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.itemCount} line{row.itemCount === 1 ? '' : 's'} · {formatMoney(row.estimatedTotalMinor, currency)} ·{' '}
                    {row.heldByNameSnapshot} · {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}
                    {row.customerName ? ` · ${row.customerName}` : ''}
                  </p>
                </div>
                <Button size="sm" loading={resume.isPending && resume.variables === row._id} onClick={() => resume.mutate(row._id)}>
                  Open
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Discard ${row.holdNumber}`}
                  loading={discard.isPending && discard.variables === row._id}
                  onClick={() => discard.mutate(row._id)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-muted-foreground">A held sale is kept for 7 days and then removed on its own.</p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
