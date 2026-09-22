import * as React from 'react';
import JsBarcode from 'jsbarcode';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { QrCodeView } from '@/features/printing/QrCodeView';

export interface BarcodeLabelData {
  barcode: string;
  productName: string;
  variantName: string;
  sku: string;
  priceMinor: number;
}

interface BarcodeLabelProps {
  data: BarcodeLabelData;
  currency: string;
  storeName?: string;
  showPrice?: boolean;
  /** Label width from store settings (38, 48 or 58 mm). */
  widthMm?: number;
  /** Adds a QR code of the barcode value (scannable by a phone). */
  showQr?: boolean;
  className?: string;
}

/**
 * A single printable shelf/garment label.
 *
 * `jsbarcode` renders a real, scannable symbol into an <svg>. EAN-13 is used
 * when the value is a valid 13-digit code (which is what our generator issues)
 * and CODE128 otherwise, so a barcode typed in from a supplier's label still
 * renders correctly.
 */
export function BarcodeLabel({ data, currency, storeName, showPrice = true, widthMm = 38, showQr = false, className }: BarcodeLabelProps) {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!svgRef.current) return;
    const isEan13 = /^\d{13}$/.test(data.barcode);

    try {
      JsBarcode(svgRef.current, data.barcode, {
        format: isEan13 ? 'EAN13' : 'CODE128',
        width: 1.6,
        height: 38,
        fontSize: 12,
        margin: 0,
        displayValue: true,
      });
      setError(null);
    } catch {
      // An invalid symbology should say so on screen rather than print blank.
      setError('This value cannot be encoded as a barcode');
    }
  }, [data.barcode]);

  return (
    <div className={cn('barcode-label', className)} data-width={widthMm} style={{ ['--label-width' as string]: `${widthMm}mm` }}>
      {storeName && <div className="bl-store">{storeName}</div>}
      <div className="bl-name">{data.productName}</div>
      {data.variantName && data.variantName !== 'Default' && <div className="bl-variant">{data.variantName}</div>}
      {error ? (
        <div className="bl-error">{error}</div>
      ) : (
        // data-barcode-*: direct thermal printing redraws this at printer resolution.
        <svg ref={svgRef} className="bl-svg" data-barcode-value={data.barcode} data-barcode-format={/^\d{13}$/.test(data.barcode) ? 'EAN13' : 'CODE128'} />
      )}
      {showQr && !error && <QrCodeView value={data.barcode} sizeMm={Math.min(18, Math.round(widthMm * 0.4))} className="bl-qr" />}
      {showPrice && <div className="bl-price">{formatMoney(data.priceMinor, currency)}</div>}
    </div>
  );
}
