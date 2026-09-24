import * as React from 'react';
import { resolveReceiptWidth } from './ThermalReceipt';

/**
 * The paper every POS vertical prints on.
 *
 * One node, one id, one set of styles: `#receipt-print-area` is what the browser
 * print CSS isolates AND what the QZ Tray path rasterises, so a receipt that
 * looks right on screen is the receipt that comes out of the printer. A vertical
 * supplies its own content; nothing about the paper itself is per-vertical.
 *
 * `@page` cannot read a CSS custom property, so the physical page size is
 * injected here from the store's configured width.
 */
export function ReceiptPaper({
  widthMm,
  children,
  className,
}: {
  /** The store's configured width; anything unexpected falls back to 58mm. */
  widthMm: number | undefined | null;
  children: React.ReactNode;
  className?: string;
}) {
  const width = resolveReceiptWidth(widthMm);
  return (
    <>
      <style>{`@media print { @page { size: ${width}mm auto; margin: 0; } #receipt-print-area { width: ${width}mm; } }`}</style>
      <div
        id="receipt-print-area"
        className={`receipt-paper mx-auto shadow-sm${className ? ` ${className}` : ''}`}
        data-width={width}
        style={{ ['--receipt-width' as string]: `${width}mm` }}
      >
        {children}
      </div>
    </>
  );
}
