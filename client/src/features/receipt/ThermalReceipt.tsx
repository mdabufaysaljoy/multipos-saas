import { format } from 'date-fns';
import { formatMoney } from '@/lib/money';
import type { ReceiptPayload } from '@/types/domain';

const SUPPORTED_WIDTHS = [58, 78, 80] as const;
export type ReceiptWidth = (typeof SUPPORTED_WIDTHS)[number];

/** Falls back to 58mm for any unexpected stored value. */
export const resolveReceiptWidth = (value: number | undefined | null): ReceiptWidth =>
  SUPPORTED_WIDTHS.includes(value as ReceiptWidth) ? (value as ReceiptWidth) : 58;

/**
 * Thermal receipt, rendered at the width configured in store settings
 * (58mm / 78mm / 80mm).
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
  const showLogo = store.receipt.showLogo && Boolean(store.logoUrl);

  return (
    <>
      {/*
        @page cannot read a CSS custom property, so the physical page size is
        injected here from the store's configured width.
      */}
      <style>{`@media print { @page { size: ${width}mm auto; margin: 0; } #receipt-print-area { width: ${width}mm; } }`}</style>

      <div
        id="receipt-print-area"
        className="receipt-paper mx-auto shadow-sm"
        data-width={width}
        style={{ ['--receipt-width' as string]: `${width}mm` }}
      >
        <div className="r-center">
          {showLogo && <img src={store.logoUrl!} alt="" className="r-logo" />}
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
            <tr>
              <td className="r-sm">Subtotal</td>
              <td className="r-sm r-right">{formatMoney(sale.subtotalMinor, currency)}</td>
            </tr>
            {sale.discountMinor > 0 && (
              <tr>
                <td className="r-sm">Discount</td>
                <td className="r-sm r-right">-{formatMoney(sale.discountMinor, currency)}</td>
              </tr>
            )}
            {sale.taxMinor > 0 && (
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

            {/* Payment breakdown - one line per tender, so a split payment is
                fully reproduced on the printed receipt. */}
            {sale.payments && sale.payments.length > 0 ? (
              sale.payments.map((payment, index) => (
                <tr key={`${payment.method}-${index}`}>
                  <td className="r-sm" style={index === 0 ? { paddingTop: '1mm' } : undefined}>
                    Paid ({payment.method})
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

            {sale.changeMinor > 0 && (
              <tr>
                <td className="r-sm">Change</td>
                <td className="r-sm r-right">{formatMoney(sale.changeMinor, currency)}</td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="r-rule" />

        <div className="r-center r-sm">
          <div>Items: {sale.items.reduce((sum, item) => sum + item.quantity, 0)}</div>
          {store.receipt.returnPolicy && <div style={{ marginTop: '1.5mm' }}>{store.receipt.returnPolicy}</div>}
          {store.receipt.footerText && (
            <div className="r-bold" style={{ marginTop: '1.5mm' }}>
              {store.receipt.footerText}
            </div>
          )}
          <div style={{ marginTop: '2mm' }}>. . .</div>
        </div>
      </div>
    </>
  );
}

/** Triggers the browser print dialog; CSS isolates the receipt node. */
export const printReceipt = () => window.print();
