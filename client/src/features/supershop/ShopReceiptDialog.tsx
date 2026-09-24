import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Printer, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { LoadingState, ErrorState } from '@/components/states';
import { supershopApi } from '@/api/supershop';
import { ReceiptPrintBar } from '@/features/receipt/ReceiptPrintBar';
import { useReceiptPrint } from '@/features/receipt/useReceiptPrint';
import { resolveReceiptWidth } from '@/features/receipt/ThermalReceipt';
import { ShopThermalReceipt } from './ShopThermalReceipt';

/**
 * The Super Shop receipt.
 *
 * The same printing behaviour as every other vertical: direct to the thermal
 * printer through QZ Tray when this computer is set up for it - no browser
 * dialog, no printer picker - and the browser print dialog otherwise. Printing
 * only outputs the receipt that was already fetched, so a retry can never
 * create a second sale.
 */
export function ShopReceiptDialog({
  saleId,
  onClose,
  onNewSale,
  autoPrint = false,
}: {
  saleId: string | null;
  onClose: () => void;
  /** Extra call to action shown after completing a sale. */
  onNewSale?: () => void;
  /** Prints once as soon as the receipt renders - used right after a sale. */
  autoPrint?: boolean;
}) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['supershop', 'receipt', saleId],
    queryFn: () => supershopApi.receipt(saleId!),
    enabled: Boolean(saleId),
  });

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
          <h2 className="font-semibold">Receipt {data?.sale.saleNumber ?? ''}</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>

        <div ref={receiptHost} className="scrollbar-thin max-h-[65vh] overflow-y-auto rounded-md bg-muted/40 p-3">
          {isLoading && <LoadingState label="Preparing receipt…" />}
          {isError && <ErrorState message="Could not load the receipt" onRetry={() => void refetch()} />}
          {data && <ShopThermalReceipt payload={data} />}
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
