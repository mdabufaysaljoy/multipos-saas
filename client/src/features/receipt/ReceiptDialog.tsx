import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Printer, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { LoadingState, ErrorState } from '@/components/states';
import { saleApi } from '@/api/endpoints';
import { ReceiptPrintBar } from './ReceiptPrintBar';
import { useReceiptPrint } from './useReceiptPrint';
import { ThermalReceipt, resolveReceiptWidth } from './ThermalReceipt';

interface ReceiptDialogProps {
  saleId: string | null;
  onClose: () => void;
  /** Extra call to action shown after completing a sale. */
  onNewSale?: () => void;
  /**
   * Prints once, as soon as the receipt has rendered - used right after a sale
   * is created. Reprints from sale history leave it off.
   */
  autoPrint?: boolean;
}

export function ReceiptDialog({ saleId, onClose, onNewSale, autoPrint = false }: ReceiptDialogProps) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['receipt', saleId],
    queryFn: () => saleApi.receipt(saleId!),
    enabled: Boolean(saleId),
  });

  // Direct (QZ Tray) printing when this computer is set up for it; otherwise
  // the browser print dialog. Either way printing only OUTPUTS the receipt
  // already fetched above - it never calls the sale API again, so a failed or
  // retried print cannot create a sale, move stock or award loyalty points.
  const receiptHost = React.useRef<HTMLDivElement>(null);
  const print = useReceiptPrint({
    host: receiptHost,
    documentId: saleId,
    ready: Boolean(data),
    autoPrint,
    afterSale: Boolean(onNewSale),
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

        <div ref={receiptHost} className="scrollbar-thin max-h-[65vh] overflow-y-auto rounded-md bg-muted/40 p-3">
          {isLoading && <LoadingState label="Preparing receipt…" />}
          {isError && <ErrorState message="Could not load the receipt" onRetry={() => void refetch()} />}
          {data && <ThermalReceipt payload={data} />}
        </div>

        <ReceiptPrintBar print={print} />

        <div className="no-print flex gap-2">
          <Button className="flex-1" onClick={print.print} disabled={!data} loading={print.direct && print.status === 'printing'}>
            <Printer />
            {print.direct ? 'Print' : `Print (${resolveReceiptWidth(data?.store.receipt?.paperWidthMm)}mm)`}
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
