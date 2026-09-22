import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
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

  // Printed once per sale. The sale already exists by now, so a blocked or
  // cancelled print never touches it - the Print button below stays available.
  const printedFor = React.useRef<string | null>(null);
  const [autoPrintState, setAutoPrintState] = React.useState<'idle' | 'opened' | 'blocked'>('idle');
  React.useEffect(() => {
    if (!autoPrint || !saleId || !data || printedFor.current === saleId) return;
    printedFor.current = saleId;
    // Let the dialog paint the receipt first; the print CSS isolates it.
    const timer = window.setTimeout(() => {
      try {
        printReceipt();
        setAutoPrintState('opened');
      } catch {
        setAutoPrintState('blocked');
        toast.error('Automatic printing was blocked', { description: 'Use the Print button to print this receipt.' });
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [autoPrint, saleId, data]);
  React.useEffect(() => {
    if (!saleId) setAutoPrintState('idle');
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

        <div className="scrollbar-thin max-h-[65vh] overflow-y-auto rounded-md bg-muted/40 p-3">
          {isLoading && <LoadingState label="Preparing receipt…" />}
          {isError && <ErrorState message="Could not load the receipt" onRetry={() => void refetch()} />}
          {data && <ThermalReceipt payload={data} />}
        </div>

        {autoPrintState !== 'idle' && (
          <p className="no-print text-xs text-muted-foreground">
            {autoPrintState === 'blocked'
              ? 'The browser blocked automatic printing. Use Print below.'
              : 'The print dialog opened automatically. If it did not appear, or the printer missed it, use Print below.'}
          </p>
        )}

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
