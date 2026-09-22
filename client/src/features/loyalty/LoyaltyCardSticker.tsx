import * as React from 'react';
import JsBarcode from 'jsbarcode';

export interface LoyaltyCardData {
  cardNumber: string;
  barcode: string;
  customerName: string;
  phone: string;
  email?: string;
}

interface LoyaltyCardStickerProps {
  card: LoyaltyCardData;
  storeName: string;
  logoUrl?: string | null;
  showEmail?: boolean;
  /** Sticker width from store settings (48, 58 or 85 mm). */
  widthMm?: number;
}

/**
 * A printable membership-card sticker: 85 x 54 mm (bank-card size) by default,
 * or 58 / 48 mm wide for label rolls (Settings → Labels). The barcode is the card's own stored code -
 * printing never creates a new one - drawn as EAN-13 with a proper quiet zone,
 * black on white, and nothing decorative over it.
 */
export function LoyaltyCardSticker({ card, storeName, logoUrl, showEmail = true, widthMm = 85 }: LoyaltyCardStickerProps) {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    if (!svgRef.current) return;
    try {
      JsBarcode(svgRef.current, card.barcode, {
        format: /^\d{13}$/.test(card.barcode) ? 'EAN13' : 'CODE128',
        width: 2,
        height: 48,
        fontSize: 13,
        // Quiet zone: EAN-13 needs clear space either side of the bars.
        margin: 10,
        background: '#ffffff',
        lineColor: '#000000',
        displayValue: true,
      });
      setError(false);
    } catch {
      setError(true);
    }
  }, [card.barcode]);

  return (
    <div className="loyalty-card" data-width={widthMm} style={{ ['--card-width' as string]: `${widthMm}mm` }}>
      <div className="lc-head">
        {logoUrl ? <img src={logoUrl} alt="" className="lc-logo" /> : null}
        <div className="lc-store">{storeName}</div>
      </div>
      <div className="lc-title">LOYALTY MEMBER</div>
      <div className="lc-name">{card.customerName}</div>
      <div className="lc-contact">{card.phone}</div>
      {showEmail && card.email ? <div className="lc-contact">{card.email}</div> : null}
      {error ? <div className="lc-error">This card code cannot be drawn as a barcode</div> : <svg ref={svgRef} className="lc-barcode" />}
      <div className="lc-number">{card.cardNumber}</div>
    </div>
  );
}
