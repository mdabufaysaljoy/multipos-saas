import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ReceiptPrintState } from './useReceiptPrint';

/**
 * What the till is told about a print, in every vertical.
 *
 * Direct printing reports itself here - printing, printed, or failed with a
 * reason, a Retry and a way back to the browser dialog. The wording says "sale
 * completed, but…" after a sale, because the sale is not in doubt: only the
 * paper is.
 */
export function ReceiptPrintBar({ print }: { print: ReceiptPrintState }) {
  if (print.direct) {
    if (print.status === 'idle') return null;
    const failed = print.status === 'failed';
    return (
      <div
        role="status"
        className={
          failed
            ? 'no-print space-y-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive'
            : 'no-print rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground'
        }
      >
        {print.status === 'printing' && <p>{print.afterSale ? 'Sale completed. Printing receipt…' : 'Printing receipt…'}</p>}
        {print.status === 'printed' && <p className="text-success">{print.message}</p>}
        {failed && (
          <>
            <p>
              <span className="font-semibold">
                {print.afterSale ? 'Sale completed, but the receipt did not print. ' : 'The receipt did not print. '}
              </span>
              {print.message}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={print.printDirect}>
                <RotateCw />
                Retry print
              </Button>
              <Button size="sm" variant="ghost" onClick={print.printBrowser}>
                Print using browser
              </Button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (print.autoPrintState === 'idle') return null;
  return (
    <p className="no-print text-xs text-muted-foreground">
      {print.autoPrintState === 'blocked'
        ? 'The browser blocked automatic printing. Use Print below.'
        : 'The print dialog opened automatically. If it did not appear, or the printer missed it, use Print below.'}
    </p>
  );
}
