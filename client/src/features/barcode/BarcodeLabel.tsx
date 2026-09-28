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
  /** The store's VAT switch (`store.tax.enabled`): prints "+ VAT" after the price. Display only. */
  vatEnabled?: boolean;
  /** Label width from store settings (38, 48 or 58 mm). */
  widthMm?: number;
  /** Adds a QR code of the barcode value (scannable by a phone). */
  showQr?: boolean;
  /** Super Shop accepts supplier codes whose 13th digit is not a valid EAN check digit. */
  validateEan13?: boolean;
  className?: string;
}

/** Use EAN-13 only when all thirteen digits, including the check digit, are valid. */
export function barcodeFormat(value: string): 'EAN13' | 'CODE128' {
  if (!/^\d{13}$/.test(value)) return 'CODE128';
  const body = value.slice(0, 12);
  const sum = body.split('').reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  const expectedCheckDigit = (10 - (sum % 10)) % 10;
  return Number(value[12]) === expectedCheckDigit ? 'EAN13' : 'CODE128';
}

/**
 * A single printable shelf/garment label.
 *
 * `jsbarcode` renders a real, scannable symbol into an <svg>. EAN-13 is used
 * when the value is a valid 13-digit code (which is what our generator issues)
 * and CODE128 otherwise, so a barcode typed in from a supplier's label still
 * renders correctly.
 */
export function BarcodeLabel({
  data,
  currency,
  storeName,
  showPrice = true,
  vatEnabled = false,
  widthMm = 38,
  showQr = false,
  validateEan13 = false,
  className,
}: BarcodeLabelProps) {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const format = validateEan13 ? barcodeFormat(data.barcode) : /^\d{13}$/.test(data.barcode) ? 'EAN13' : 'CODE128';

  React.useEffect(() => {
    if (!svgRef.current) return;

    try {
      JsBarcode(svgRef.current, data.barcode, {
        format,
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
  }, [data.barcode, format]);

  return (
    <div
      className={cn('barcode-label', className)}
      data-width={widthMm}
      style={{ ['--label-width' as string]: `${widthMm}mm` }}
    >
      {storeName && <div className="bl-store">{storeName}</div>}
      <div className="bl-name">{data.productName}</div>
      {data.variantName && data.variantName !== 'Default' && <div className="bl-variant">{data.variantName}</div>}
      {error && <div className="bl-error">{error}</div>}
      {/* data-barcode-*: direct thermal printing redraws this at printer resolution. */}
      <svg
        ref={svgRef}
        className={cn('bl-svg', error && 'hidden')}
        data-barcode-value={data.barcode}
        data-barcode-format={format}
      />
      {showQr && !error && (
        <QrCodeView value={data.barcode} sizeMm={Math.min(18, Math.round(widthMm * 0.4))} className="bl-qr" />
      )}
      {showPrice && (
        <div className="bl-price">
          {formatMoney(data.priceMinor, currency)}
          {/* The price itself is unchanged; this only says VAT is charged on top. */}
          {vatEnabled && <span className="bl-vat"> + VAT</span>}
        </div>
      )}
    </div>
  );
}
