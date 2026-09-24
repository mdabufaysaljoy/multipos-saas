import * as React from 'react';
import { toast } from 'sonner';
import { useThermalPrint } from '@/features/printing/useThermalPrint';
import { printReceipt } from './ThermalReceipt';

/**
 * Printing a receipt, for every POS vertical.
 *
 * Direct (QZ Tray) printing when this computer is set up for it, the browser
 * print dialog otherwise, and - after a sale - one automatic print with no
 * dialog, no printer picker and no second click.
 *
 * Printing only OUTPUTS a receipt that already exists. It never calls a sale,
 * order or return API, so a failed print, a retry or a reprint cannot create a
 * sale, move stock, take a payment or award points. That is why a print failure
 * is reported next to the receipt instead of unwinding anything.
 */
export interface ReceiptPrintOptions {
  /** The element holding the rendered `#receipt-print-area`. */
  host: React.RefObject<HTMLElement | null>;
  /** Identifies the document; auto-print happens once per id. */
  documentId: string | null;
  /** True once the receipt has rendered inside `host`. */
  ready: boolean;
  /** Print as soon as it is ready - used right after a sale, not for reprints. */
  autoPrint?: boolean;
  /** Wording for the "sale completed, but…" case. */
  afterSale?: boolean;
}

export type AutoPrintState = 'idle' | 'opened' | 'blocked';

export function useReceiptPrint({ host, documentId, ready, autoPrint = false, afterSale = false }: ReceiptPrintOptions) {
  const thermal = useThermalPrint();

  const printDirect = React.useCallback(() => {
    const element = host.current?.querySelector<HTMLElement>('#receipt-print-area');
    if (element) void thermal.print({ type: 'receipt', element });
  }, [host, thermal]);

  // Printed once per document. The sale already exists by now, so a blocked or
  // failed print never touches it - the Print / Retry buttons stay available.
  const printedFor = React.useRef<string | null>(null);
  const [autoPrintState, setAutoPrintState] = React.useState<AutoPrintState>('idle');

  React.useEffect(() => {
    if (!autoPrint || !documentId || !ready || printedFor.current === documentId) return;
    printedFor.current = documentId;
    // Let the dialog paint the receipt first; both paths read the rendered DOM.
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
  }, [autoPrint, documentId, ready, thermal.direct, printDirect]);

  React.useEffect(() => {
    if (documentId) return;
    setAutoPrintState('idle');
    thermal.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  return {
    /** True when this computer prints through QZ Tray rather than the browser. */
    direct: thermal.direct,
    status: thermal.status,
    message: thermal.message,
    autoPrintState,
    afterSale,
    printDirect,
    printBrowser: printReceipt,
    /** What the main button does on this computer. */
    print: thermal.direct ? printDirect : printReceipt,
  };
}

export type ReceiptPrintState = ReturnType<typeof useReceiptPrint>;
