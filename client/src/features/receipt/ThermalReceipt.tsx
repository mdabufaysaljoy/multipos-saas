import { format } from 'date-fns';
import { ReceiptPaper } from './ReceiptPaper';
import { formatMoney } from '@/lib/money';
import type { ReceiptPayload } from '@/types/domain';
import { tenderLabel } from '@/types/domain';

/** Thermal paper widths the receipt layout is built for, in millimetres. */
export const SUPPORTED_WIDTHS = [48, 57, 58, 78, 80, 88] as const;
export type ReceiptWidth = (typeof SUPPORTED_WIDTHS)[number];

/** Falls back to 58mm for any unexpected stored value. */
/** Printed at the foot of every receipt. Platform branding - there is deliberately no setting to hide it. */
const PLATFORM_RECEIPT_BRANDING = 'https://retailersuites.com';

export const resolveReceiptWidth = (value: number | undefined | null): ReceiptWidth =>
  SUPPORTED_WIDTHS.includes(value as ReceiptWidth) ? (value as ReceiptWidth) : 58;

/**
 * Thermal receipt, rendered at the width configured in store settings
 * (48 / 57 / 58 / 78 / 80 / 88 mm).
 *
 * There is one layout, parameterised by `--receipt-width`, rather than three
 * separate receipt systems. It is real DOM inside `#receipt-print-area` and is
 * printed through the browser; keeping it as HTML means a direct ESC/POS driver
 * can later walk the same structure without a redesign.
 */
export function ThermalReceipt({ payload }: { payload: ReceiptPayload }) {
  const { sale, store } = payload;
  const currency = store.currency;
  const width = resolveReceiptWidth(store.receipt?.paperWidthMm);
  const showTaxBreakdown = Boolean(store.tax?.enabled) || sale.taxMinor > 0;
  // The RECEIPT logo, not the UI store logo - they are separate settings.
  const showLogo = store.receipt.showLogo && Boolean(store.receiptLogoUrl);
  // The sale's discount total includes loyalty points; they print as separate lines.
  const loyalty = sale.loyalty ?? null;
  const loyaltyDiscountMinor = loyalty?.discountMinor ?? 0;
  const cartDiscountMinor = sale.discountMinor - loyaltyDiscountMinor;
  const paidWithPointsOnly = Boolean(loyalty) && sale.totalMinor === 0 && (sale.payments ?? []).length === 0;

  return (
    <ReceiptPaper widthMm={width}>
      <>
        <div className="r-center">
          {showLogo && <img src={store.receiptLogoUrl!} alt="" className="r-logo" />}
          <div className="r-bold" style={{ fontSize: '1.15em' }}>
            {store.receipt.headerText || store.name}
          </div>
          {store.address && <div className="r-sm">{store.address}</div>}
          {store.phone && <div className="r-sm">Tel: {store.phone}</div>}
          {store.email && <div className="r-sm">{store.email}</div>}
        </div>

        <div className="r-rule" />

        <table>
          <tbody>
            <tr>
              <td className="r-sm">Invoice</td>
              <td className="r-sm r-right r-bold">{sale.saleNumber}</td>
            </tr>
            <tr>
              <td className="r-sm">Date</td>
              <td className="r-sm r-right">{format(new Date(sale.soldAt), 'dd/MM/yyyy hh:mm a')}</td>
            </tr>
            {store.receipt.showCashier && (
              <tr>
                <td className="r-sm">Cashier</td>
                <td className="r-sm r-right">{sale.cashierNameSnapshot}</td>
              </tr>
            )}
            {sale.customerSnapshot && (
              <>
                <tr>
                  <td className="r-sm">Customer</td>
                  <td className="r-sm r-right">{sale.customerSnapshot.name}</td>
                </tr>
                {sale.customerSnapshot.phone && (
                  <tr>
                    <td className="r-sm">Phone</td>
                    <td className="r-sm r-right">{sale.customerSnapshot.phone}</td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>

        <div className="r-rule" />

        {/* Exchange: what came back and its value, above the replacement goods. */}
        {sale.exchange && (
          <>
            <div className="r-center r-bold">EXCHANGE</div>
            {sale.exchange.returnNumber && <div className="r-center r-sm">Return {sale.exchange.returnNumber}</div>}
            <div className="r-sm r-bold" style={{ marginTop: '1mm' }}>Returned:</div>
            <table>
              <tbody>
                {sale.exchange.returnedItems.map((item, index) => (
                  <tr key={`returned-${index}`}>
                    <td className="r-sm">
                      {item.quantity} × {item.productNameSnapshot}
                      {item.variantNameSnapshot && item.variantNameSnapshot !== 'Default' ? ` (${item.variantNameSnapshot})` : ''}
                    </td>
                    <td className="r-sm r-right">{formatMoney(item.lineTotalMinor, currency)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="r-sm r-bold">Refund value</td>
                  <td className="r-sm r-bold r-right">{formatMoney(sale.exchange.creditMinor, currency)}</td>
                </tr>
              </tbody>
            </table>
            <div className="r-rule" />
            <div className="r-sm r-bold">Replacement:</div>
          </>
        )}

        <table>
          <tbody>
            {sale.items.map((item) => (
              <tr key={item._id}>
                <td colSpan={2} style={{ paddingBottom: '1mm' }}>
                  {/* Every value here is the SNAPSHOT taken at the time of sale,
                      so reprinting an old receipt years later is identical even
                      if the product has since changed or been deleted. */}
                  <div>{item.productNameSnapshot}</div>
                  {item.variantNameSnapshot && item.variantNameSnapshot !== 'Default' && (
                    <div className="r-sm">{item.variantNameSnapshot}</div>
                  )}
                  <div className="r-sm" style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>
                      {item.quantity} × {formatMoney(item.unitPriceMinor, currency)}
                    </span>
                    <span className="r-bold">{formatMoney(item.lineTotalMinor, currency)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="r-rule" />

        <table>
          <tbody>
            {/* Subtotal and VAT follow the store's VAT setting, like the POS
                summary. A sale that actually charged VAT keeps its breakdown on
                reprint, so an old receipt stays accurate if VAT is later turned off. */}
            {showTaxBreakdown && (
              <tr>
                <td className="r-sm">Subtotal</td>
                <td className="r-sm r-right">{formatMoney(sale.subtotalMinor, currency)}</td>
              </tr>
            )}
            {cartDiscountMinor > 0 && (
              <tr>
                <td className="r-sm">Discount</td>
                <td className="r-sm r-right">-{formatMoney(cartDiscountMinor, currency)}</td>
              </tr>
            )}
            {loyaltyDiscountMinor > 0 && (
              <tr>
                <td className="r-sm">Loyalty discount</td>
                <td className="r-sm r-right">-{formatMoney(loyaltyDiscountMinor, currency)}</td>
              </tr>
            )}
            {showTaxBreakdown && sale.taxMinor > 0 && (
              <tr>
                <td className="r-sm">{store.tax.label || 'Tax'}</td>
                <td className="r-sm r-right">{formatMoney(sale.taxMinor, currency)}</td>
              </tr>
            )}
            <tr>
              <td className="r-bold" style={{ fontSize: '1.15em', paddingTop: '1mm' }}>
                TOTAL
              </td>
              <td className="r-bold r-right" style={{ fontSize: '1.15em', paddingTop: '1mm' }}>
                {formatMoney(sale.totalMinor, currency)}
              </td>
            </tr>

            {sale.exchange && (
              <>
                <tr>
                  <td className="r-sm" style={{ paddingTop: '1mm' }}>Exchange credit</td>
                  <td className="r-sm r-right" style={{ paddingTop: '1mm' }}>-{formatMoney(sale.exchange.creditMinor, currency)}</td>
                </tr>
                <tr>
                  <td className="r-sm r-bold">Extra payable</td>
                  <td className="r-sm r-bold r-right">{formatMoney(sale.totalMinor - sale.exchange.creditMinor, currency)}</td>
                </tr>
              </>
            )}

            {/* Payment breakdown - one line per tender, so a split payment is
                fully reproduced on the printed receipt. */}
            {(sale.exchange && (!sale.payments || sale.payments.length === 0)) || paidWithPointsOnly ? null : sale.payments && sale.payments.length > 0 ? (
              sale.payments.map((payment, index) => (
                <tr key={`${payment.method}-${index}`}>
                  <td className="r-sm" style={index === 0 ? { paddingTop: '1mm' } : undefined}>
                    Paid ({tenderLabel(payment)})
                  </td>
                  <td className="r-sm r-right" style={index === 0 ? { paddingTop: '1mm' } : undefined}>
                    {formatMoney(payment.amountMinor, currency)}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="r-sm" style={{ paddingTop: '1mm' }}>
                  Paid ({sale.paymentMethod})
                </td>
                <td className="r-sm r-right" style={{ paddingTop: '1mm' }}>
                  {formatMoney(sale.paidMinor, currency)}
                </td>
              </tr>
            )}

            {/* What the customer handed over, and the change given back. The
                TOTAL above never includes change. Shown for any sale taken
                partly in cash, so an exact cash sale still prints Change 0. */}
            {!paidWithPointsOnly && (sale.changeMinor > 0 || (sale.payments ?? []).some((payment) => payment.method === 'cash') || sale.paymentMethod === 'cash') && (
              <>
                <tr>
                  <td className="r-sm">Customer paid</td>
                  {/* For an exchange, only the money handed over - not the returned goods' value. */}
                  <td className="r-sm r-right">{formatMoney(sale.paidMinor - (sale.exchange?.creditMinor ?? 0), currency)}</td>
                </tr>
                <tr>
                  <td className="r-sm r-bold">Change</td>
                  <td className="r-sm r-bold r-right">{formatMoney(sale.changeMinor, currency)}</td>
                </tr>
              </>
            )}
          </tbody>
        </table>

        {/* Loyalty: only for a card sale, and only the lines that apply. */}
        {loyalty && (
          <>
            <div className="r-rule" />
            <div className="r-center r-sm r-bold">LOYALTY · {loyalty.cardNumber}</div>
            <table>
              <tbody>
                {loyalty.pointsRedeemed > 0 && (
                  <tr>
                    <td className="r-sm">Points redeemed</td>
                    <td className="r-sm r-right">{loyalty.pointsRedeemed}</td>
                  </tr>
                )}
                {loyalty.pointsEarned > 0 && (
                  <tr>
                    <td className="r-sm">Points earned</td>
                    <td className="r-sm r-right">{loyalty.pointsEarned}</td>
                  </tr>
                )}
                <tr>
                  <td className="r-sm r-bold">Points balance</td>
                  <td className="r-sm r-bold r-right">{loyalty.balanceAfter}</td>
                </tr>
              </tbody>
            </table>
          </>
        )}

        <div className="r-rule" />

        <div className="r-center r-sm">
          <div>Items: {sale.items.reduce((sum, item) => sum + item.quantity, 0)}</div>
          {store.receipt.returnPolicy && <div style={{ marginTop: '1.5mm' }}>{store.receipt.returnPolicy}</div>}
          {store.receipt.footerText && (
            <div className="r-bold" style={{ marginTop: '1.5mm' }}>
              {store.receipt.footerText}
            </div>
          )}
          {/* Platform branding: fixed in the template, not read from settings, props or the API. */}
          <div style={{ marginTop: '2mm', fontSize: '0.85em' }}>{PLATFORM_RECEIPT_BRANDING}</div>
        </div>
      </>
    </ReceiptPaper>
  );
}

/** Triggers the browser print dialog; CSS isolates the receipt node. */
export const printReceipt = () => window.print();
