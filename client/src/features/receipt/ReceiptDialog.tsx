import { useQuery } from '@tanstack/react-query';
import { Printer, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { LoadingState, ErrorState } from '@/components/states';
import { saleApi } from '@/api/endpoints';
import { ThermalReceipt, printReceipt, resolveReceiptWidth } from './ThermalReceipt';

interface ReceiptDialogProps {
  saleId: string | null;
  onClose: () => void;
  /** Extra call to action shown after completing a sale. */
  onNewSale?: () => void;
}

export function ReceiptDialog({ saleId, onClose, onNewSale }: ReceiptDialogProps) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['receipt', saleId],
    queryFn: () => saleApi.receipt(saleId!),
    enabled: Boolean(saleId),
  });

  return (
    <Dialog open={Boolean(saleId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md gap-3 p-4" hideClose>
        <div className="no-print flex items-center justify-between">
          <h2 className="font-semibold">Receipt</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>

        <div className="scrollbar-thin max-h-[65vh] overflow-y-auto rounded-md bg-muted/40 p-3">
          {isLoading && <LoadingState label="Preparing receipt…" />}
          {isError && <ErrorState message="Could not load the receipt" onRetry={() => void refetch()} />}
          {data && <ThermalReceipt payload={data} />}
        </div>

        <div className="no-print flex gap-2">
          <Button className="flex-1" onClick={printReceipt} disabled={!data}>
            <Printer />
            Print ({resolveReceiptWidth(data?.store.receipt?.paperWidthMm)}mm)
          </Button>
          {onNewSale && (
            <Button variant="outline" className="flex-1" onClick={onNewSale}>
              New sale
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
