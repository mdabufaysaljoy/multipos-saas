import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { PauseCircle, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { pharmacyApi } from '@/api/pharmacy';
import { ApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, LoadingState } from '@/components/states';
import { formatMoney } from '@/lib/money';
import type { PharmacyResumedSale } from '@/types/pharmacy';

export function PharmacyHeldSalesDialog({ currency, onClose, onResumed }: { currency: string; onClose: () => void; onResumed: (sale: PharmacyResumedSale) => void }) {
  const client = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['pharmacy', 'held-sales'], queryFn: pharmacyApi.heldSales });
  const resume = useMutation({
    mutationFn: pharmacyApi.resumeHold,
    onSuccess: (sale) => { onResumed(sale); void client.invalidateQueries({ queryKey: ['pharmacy', 'held-sales'] }); onClose(); },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not open that held sale'),
  });
  const discard = useMutation({
    mutationFn: pharmacyApi.removeHold,
    onSuccess: (result) => { toast.success(`${result.holdNumber} discarded`); void client.invalidateQueries({ queryKey: ['pharmacy', 'held-sales'] }); },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not discard that held sale'),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><PauseCircle className="h-4 w-4" /> Held sales</DialogTitle><DialogDescription>Open a parked basket to continue it at today’s medicine prices.</DialogDescription></DialogHeader>
        {isLoading ? <LoadingState label="Loading held sales…" /> : (data ?? []).length === 0 ? <EmptyState title="Nothing is on hold" description="Held Pharmacy sales wait here for 7 days." /> : (
          <ul className="divide-y rounded-md border">{data?.map((row) => (
            <li key={row._id} className="flex items-center gap-2 p-2.5">
              <div className="min-w-0 flex-1"><p className="font-mono text-sm font-medium">{row.holdNumber}</p><p className="truncate text-xs text-muted-foreground">{row.itemCount} line{row.itemCount === 1 ? '' : 's'} · {formatMoney(row.estimatedTotalMinor, currency)} · {row.heldByNameSnapshot} · {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}</p>{row.customerName && <p className="truncate text-xs font-medium">Customer: {row.customerName}</p>}</div>
              <Button size="sm" loading={resume.isPending && resume.variables === row._id} onClick={() => resume.mutate(row._id)}>Open</Button>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={`Discard ${row.holdNumber}`} loading={discard.isPending && discard.variables === row._id} onClick={() => discard.mutate(row._id)}><Trash2 /></Button>
            </li>
          ))}</ul>
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
