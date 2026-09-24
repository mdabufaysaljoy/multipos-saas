import { Fragment } from 'react';
import { format } from 'date-fns';
import { ReceiptPaper } from '@/features/receipt/ReceiptPaper';
import { formatMoney } from '@/lib/money';
import { formatQuantity } from '@/lib/supershop';
import type { ShopReceipt } from '@/types/supershop';
import { tenderLabel } from '@/types/domain';

/** Printed at the foot of every receipt. Platform branding, not a setting. */
const PLATFORM_RECEIPT_BRANDING = 'https://retailersuites.com';

/**
 * The Super Shop receipt, on the platform's shared receipt paper.
 *
 * Real DOM rather than a popup window's HTML string: the same node the browser
 * print CSS isolates is the one QZ Tray rasterises, so direct printing and the
 * browser fallback produce the same receipt at the store's configured width.
 * The contents are Super Shop's own - weight lines, VAT-inclusive totals.
 */
export function ShopThermalReceipt({ payload }: { payload: ShopReceipt }) {
  const { sale, store } = payload;
  const currency = store.currency ?? 'BDT';
  const money = (minor: number) => formatMoney(minor, currency);
  const address = typeof store.address === 'string' ? store.address : '';
  const showLogo = Boolean(store.receipt?.showLogo && store.receiptLogoUrl);

  return (
    <ReceiptPaper widthMm={store.receipt?.paperWidthMm}>
      <div className="r-center">
        {showLogo && <img src={store.receiptLogoUrl!} alt="" className="r-logo" />}
        <div className="r-bold" style={{ fontSize: '1.15em' }}>
          {store.receipt?.headerText || store.name}
        </div>
        {address && <div className="r-sm">{address}</div>}
        {store.phone && <div className="r-sm">Tel: {store.phone}</div>}
        {store.email && <div className="r-sm">{store.email}</div>}
      </div>

      <div className="r-rule" />

      <table>
        <tbody>
          <tr>
            <td className="r-sm">{sale.saleNumber}</td>
            <td className="r-sm r-right">{format(new Date(sale.soldAt), 'd MMM yyyy, HH:mm')}</td>
          </tr>
          {store.receipt?.showCashier !== false && (
            <tr>
              <td className="r-sm" colSpan={2}>
                Cashier: {sale.cashierNameSnapshot}
              </td>
            </tr>
          )}
          {sale.customerNameSnapshot && (
            <tr>
              <td className="r-sm" colSpan={2}>
                Customer: {sale.customerNameSnapshot}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {sale.status === 'voided' && (
        <div className="r-center r-bold" style={{ marginTop: '1.5mm' }}>
          *** VOIDED ***
        </div>
      )}

      <div className="r-rule" />

      <table>
        <tbody>
          {sale.items.map((line) => (
            <Fragment key={line._id}>
              <tr>
                <td colSpan={2}>{line.nameSnapshot}</td>
              </tr>
              <tr>
                <td className="r-sm">
                  {formatQuantity(line.quantity, line.unitType)} × {money(line.unitPriceMinor)}
                  {line.unitType === 'weight' ? '/kg' : ''}
                </td>
                <td className="r-right">{money(line.lineTotalMinor)}</td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>

      <div className="r-rule" />

      <table>
        <tbody>
          <tr>
            <td>Subtotal</td>
            <td className="r-right">{money(sale.subtotalMinor)}</td>
          </tr>
          {sale.discountMinor > 0 && (
            <tr>
              <td>Discount</td>
              <td className="r-right">-{money(sale.discountMinor)}</td>
            </tr>
          )}
          <tr>
            <td className="r-bold">Total</td>
            <td className="r-right r-bold">{money(sale.totalMinor)}</td>
          </tr>
          {sale.vatMinor > 0 && (
            <tr>
              <td className="r-sm">VAT included</td>
              <td className="r-sm r-right">{money(sale.vatMinor)}</td>
            </tr>
          )}
          {sale.payments.map((payment, index) => (
            <tr key={`${payment.method}-${index}`}>
              <td className="r-sm">Paid ({tenderLabel(payment)})</td>
              <td className="r-sm r-right">{money(payment.amountMinor)}</td>
            </tr>
          ))}
          {sale.changeMinor > 0 && (
            <tr>
              <td className="r-sm">Change</td>
              <td className="r-sm r-right">{money(sale.changeMinor)}</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="r-rule" />

      <div className="r-center r-sm">
        <div>Items: {sale.items.length}</div>
        {store.receipt?.returnPolicy && <div style={{ marginTop: '1.5mm' }}>{store.receipt.returnPolicy}</div>}
        {store.receipt?.footerText && (
          <div className="r-bold" style={{ marginTop: '1.5mm' }}>
            {store.receipt.footerText}
          </div>
        )}
        <div style={{ marginTop: '2mm', fontSize: '0.85em' }}>{PLATFORM_RECEIPT_BRANDING}</div>
      </div>
    </ReceiptPaper>
  );
}
