import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Printer, RotateCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { LoadingState, ErrorState } from '@/components/states';
import { saleApi } from '@/api/endpoints';
import { useThermalPrint } from '@/features/printing/useThermalPrint';
import { ThermalReceipt, printReceipt, resolveReceiptWidth } from './ThermalReceipt';

interface ReceiptDialogProps {
  saleId: string | null;
  onClose: () => void;
  /** Extra call to action shown after completing a sale. */
  onNewSale?: () => void;
  /**
   * Opens the print dialog once, as soon as the receipt has rendered - used
   * right after a sale is created. Reprints from sale history leave it off.
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
  // the existing browser printing. Either way printing only OUTPUTS the receipt
  // already fetched above - it never calls the sale API again, so a failed or
  // retried print cannot create a sale, move stock or award loyalty points.
  const thermal = useThermalPrint();
  const receiptHost = React.useRef<HTMLDivElement>(null);
  const printDirect = React.useCallback(() => {
    const element = receiptHost.current?.querySelector<HTMLElement>('#receipt-print-area');
    if (element) void thermal.print({ type: 'receipt', element });
  }, [thermal]);

  // Printed once per sale. The sale already exists by now, so a blocked or
  // failed print never touches it - the Print / Retry buttons stay available.
  const printedFor = React.useRef<string | null>(null);
  const [autoPrintState, setAutoPrintState] = React.useState<'idle' | 'opened' | 'blocked'>('idle');
  React.useEffect(() => {
    if (!autoPrint || !saleId || !data || printedFor.current === saleId) return;
    printedFor.current = saleId;
    // Let the dialog paint the receipt first; both paths read the rendered receipt.
    const timer = window.setTimeout(() => {
      if (thermal.direct) {
        printDirect();
        return;
      }
      try {
        printReceipt();
        setAutoPrintState('opened');
      } catch {
        setAutoPrintState('blocked');
        toast.error('Automatic printing was blocked', { description: 'Use the Print button to print this receipt.' });
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [autoPrint, saleId, data, thermal.direct, printDirect]);
  React.useEffect(() => {
    if (!saleId) {
      setAutoPrintState('idle');
      thermal.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleId]);

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

        {thermal.direct && thermal.status !== 'idle' && (
          <div
            role="status"
            className={
              thermal.status === 'failed'
                ? 'no-print space-y-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive'
                : 'no-print rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground'
            }
          >
            {thermal.status === 'printing' && <p>{onNewSale ? 'Sale completed. Printing receipt…' : 'Printing receipt…'}</p>}
            {thermal.status === 'printed' && <p className="text-success">{thermal.message}</p>}
            {thermal.status === 'failed' && (
              <>
                <p>
                  <span className="font-semibold">{onNewSale ? 'Sale completed, but the receipt did not print. ' : 'The receipt did not print. '}</span>
                  {thermal.message}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={printDirect}>
                    <RotateCw />
                    Retry print
                  </Button>
                  <Button size="sm" variant="ghost" onClick={printReceipt}>
                    Print using browser
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {!thermal.direct && autoPrintState !== 'idle' && (
          <p className="no-print text-xs text-muted-foreground">
            {autoPrintState === 'blocked'
              ? 'The browser blocked automatic printing. Use Print below.'
              : 'The print dialog opened automatically. If it did not appear, or the printer missed it, use Print below.'}
          </p>
        )}

        <div className="no-print flex gap-2">
          <Button
            className="flex-1"
            onClick={thermal.direct ? printDirect : printReceipt}
            disabled={!data}
            loading={thermal.direct && thermal.status === 'printing'}
          >
            <Printer />
            {thermal.direct ? 'Print' : `Print (${resolveReceiptWidth(data?.store.receipt?.paperWidthMm)}mm)`}
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
