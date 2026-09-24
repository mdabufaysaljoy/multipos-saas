import { Fragment } from 'react';
import { format } from 'date-fns';
import { ReceiptPaper } from '@/features/receipt/ReceiptPaper';
import { formatMoney } from '@/lib/money';
import { formatExpiry } from '@/lib/pharmacy';
import type { PharmacyReceipt } from '@/types/pharmacy';

/** Printed at the foot of every receipt. Platform branding, not a setting. */
const PLATFORM_RECEIPT_BRANDING = 'https://retailersuites.com';

/**
 * The Pharmacy receipt, on the platform's shared receipt paper.
 *
 * Real DOM rather than a popup window's HTML string, so the node the browser
 * print CSS isolates is the node QZ Tray rasterises. The contents are the
 * pharmacy's own: the batch each unit came from, its expiry, and the
 * prescription when the sale had one - a dispensing record the customer keeps.
 */
export function PharmacyThermalReceipt({ payload }: { payload: PharmacyReceipt }) {
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
                Served by {sale.cashierNameSnapshot}
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
                <td colSpan={2}>
                  {line.nameSnapshot} {line.strengthSnapshot}
                </td>
              </tr>
              <tr>
                <td className="r-sm">
                  {line.quantity} × {money(line.unitPriceMinor)}
                </td>
                <td className="r-right">{money(line.lineTotalMinor)}</td>
              </tr>
              {/* The dispensing record: which batch, and when it expires. */}
              {line.allocations.length > 0 && (
                <tr>
                  <td className="r-sm" colSpan={2}>
                    Batch {line.allocations.map((a) => `${a.batchNumber} (exp ${formatExpiry(a.expiryDate)})`).join(', ')}
                  </td>
                </tr>
              )}
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
          {sale.payments.map((payment, index) => (
            <tr key={`${payment.method}-${index}`}>
              <td className="r-sm">Paid ({payment.method})</td>
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

      {sale.prescription && (
        <>
          <div className="r-rule" />
          <div className="r-sm">
            <div className="r-bold">Prescription</div>
            <div>Patient: {sale.prescription.patientName}</div>
            <div>Prescriber: {sale.prescription.prescriberName}</div>
            {sale.prescription.prescriptionNumber && <div>No. {sale.prescription.prescriptionNumber}</div>}
          </div>
        </>
      )}

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
