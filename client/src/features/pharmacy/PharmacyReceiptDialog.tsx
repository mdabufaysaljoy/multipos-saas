import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LoadingState } from '@/components/states';
import { pharmacyApi } from '@/api/pharmacy';
import { formatMoney } from '@/lib/money';
import { formatExpiry } from '@/lib/pharmacy';
import type { PharmacyReceipt } from '@/types/pharmacy';

const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const addressOf = (store: PharmacyReceipt['store']) => (typeof store.address === 'string' ? store.address : '');

/**
 * Prints a narrow receipt in its own window. Every value is escaped: names,
 * patient details and notes come from users.
 */
function printReceipt({ sale, store }: PharmacyReceipt) {
  const currency = store.currency ?? 'BDT';
  const money = (minor: number) => escapeHtml(formatMoney(minor, currency));
  const lines = sale.items
    .map(
      (line) => `
        <tr><td colspan="2"><strong>${escapeHtml(line.nameSnapshot)}</strong> ${escapeHtml(line.strengthSnapshot)}</td></tr>
        <tr><td>${line.quantity} × ${money(line.unitPriceMinor)}<br><small>Batch ${escapeHtml(line.allocations.map((a) => a.batchNumber).join(', '))}</small></td>
        <td class="r">${money(line.lineTotalMinor)}</td></tr>`,
    )
    .join('');
  const rx = sale.prescription
    ? `<p>Rx: ${escapeHtml(sale.prescription.patientName)}<br>Prescriber: ${escapeHtml(sale.prescription.prescriberName)}${
        sale.prescription.prescriptionNumber ? `<br>No. ${escapeHtml(sale.prescription.prescriptionNumber)}` : ''
      }</p>`
    : '';

  const win = window.open('', '_blank', 'width=380,height=640');
  if (!win) {
    toast.error('Allow pop-ups for this site to print receipts');
    return;
  }
  win.opener = null;
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(sale.saleNumber)}</title>
    <style>body{font-family:ui-monospace,monospace;font-size:12px;width:72mm;margin:0 auto;padding:8px}h1{font-size:14px;text-align:center;margin:0}
    p{margin:6px 0}table{width:100%;border-collapse:collapse}td{vertical-align:top;padding:2px 0}.r{text-align:right}.c{text-align:center}hr{border:0;border-top:1px dashed #000}</style>
    </head><body>
    <h1>${escapeHtml(store.name)}</h1>
    <p class="c">${escapeHtml(addressOf(store))}${store.phone ? `<br>${escapeHtml(store.phone)}` : ''}</p>
    <p>${escapeHtml(sale.saleNumber)}<br>${escapeHtml(format(new Date(sale.soldAt), 'd MMM yyyy, HH:mm'))}<br>Served by ${escapeHtml(sale.cashierNameSnapshot)}</p>
    ${sale.status === 'voided' ? '<p class="c"><strong>VOIDED</strong></p>' : ''}
    <hr><table>${lines}</table><hr>
    <table>
      <tr><td>Subtotal</td><td class="r">${money(sale.subtotalMinor)}</td></tr>
      ${sale.discountMinor > 0 ? `<tr><td>Discount</td><td class="r">-${money(sale.discountMinor)}</td></tr>` : ''}
      <tr><td><strong>Total</strong></td><td class="r"><strong>${money(sale.totalMinor)}</strong></td></tr>
      <tr><td>Paid</td><td class="r">${money(sale.paidMinor)}</td></tr>
      <tr><td>Change</td><td class="r">${money(sale.changeMinor)}</td></tr>
    </table>
    ${rx}
    <p class="c">Thank you. Get well soon.</p>
    </body></html>`);
  win.document.close();
  win.focus();
  win.print();
}

export function PharmacyReceiptDialog({ saleId, onClose }: { saleId: string | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['pharmacy', 'receipt', saleId],
    queryFn: () => pharmacyApi.receipt(saleId!),
    enabled: Boolean(saleId),
  });
  const currency = data?.store.currency ?? 'BDT';

  return (
    <Dialog open={Boolean(saleId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Receipt {data?.sale.saleNumber ?? ''}</DialogTitle>
          <DialogDescription>{data ? format(new Date(data.sale.soldAt), 'd MMM yyyy, HH:mm') : ' '}</DialogDescription>
        </DialogHeader>

        {isLoading || !data ? (
          <LoadingState label="Loading receipt…" />
        ) : (
          <div className="space-y-3 text-sm">
            {data.sale.status === 'voided' && <Badge variant="destructive">Voided</Badge>}
            <ul className="divide-y">
              {data.sale.items.map((line) => (
                <li key={line._id} className="flex justify-between gap-3 py-2">
                  <div>
                    <p className="font-medium">
                      {line.nameSnapshot} {line.strengthSnapshot}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {line.quantity} × {formatMoney(line.unitPriceMinor, currency)} · batch{' '}
                      {line.allocations.map((a) => `${a.batchNumber} (exp ${formatExpiry(a.expiryDate)})`).join(', ')}
                    </p>
                  </div>
                  <span className="tabular">{formatMoney(line.lineTotalMinor, currency)}</span>
                </li>
              ))}
            </ul>
            <dl className="space-y-1">
              <Row label="Subtotal" value={formatMoney(data.sale.subtotalMinor, currency)} />
              {data.sale.discountMinor > 0 && <Row label="Discount" value={`-${formatMoney(data.sale.discountMinor, currency)}`} />}
              <Row label="Total" value={formatMoney(data.sale.totalMinor, currency)} strong />
              <Row label="Paid" value={formatMoney(data.sale.paidMinor, currency)} />
              <Row label="Change" value={formatMoney(data.sale.changeMinor, currency)} />
            </dl>
            {data.sale.prescription && (
              <div className="rounded-md border p-2 text-xs">
                Prescription for <strong>{data.sale.prescription.patientName}</strong> by {data.sale.prescription.prescriberName}
                {data.sale.prescription.prescriptionNumber ? ` · No. ${data.sale.prescription.prescriptionNumber}` : ''}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={!data} onClick={() => data && printReceipt(data)}>
            <Printer />
            Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? 'flex justify-between font-semibold' : 'flex justify-between'}>
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
