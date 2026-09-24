import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Printer, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ErrorState, LoadingState } from '@/components/states';
import { ReceiptPaper } from '@/features/receipt/ReceiptPaper';
import { ReceiptPrintBar } from '@/features/receipt/ReceiptPrintBar';
import { useReceiptPrint } from '@/features/receipt/useReceiptPrint';
import { resolveReceiptWidth } from '@/features/receipt/ThermalReceipt';
import { restaurantApi } from '@/api/restaurant';
import { formatMoney } from '@/lib/money';
import type { KitchenTicketPayload, PrintStore, RestaurantReceiptPayload, ShiftPayload } from '@/types/restaurant';

/**
 * Restaurant bills, receipts and kitchen tickets.
 *
 * They reuse the Clothing receipt's print pipeline: the same `receipt-paper`
 * styles, the same `#receipt-print-area` node the print CSS isolates, and the
 * branch's configured paper width. Only the content differs.
 */

function PaperFrame({ store, children }: { store: PrintStore; children: React.ReactNode }) {
  return <ReceiptPaper widthMm={store.receipt?.paperWidthMm}>{children}</ReceiptPaper>;
}

const Row = ({ label, value, bold }: { label: string; value: string; bold?: boolean }) => (
  <tr>
    <td className={bold ? 'r-bold' : 'r-sm'}>{label}</td>
    <td className={bold ? 'r-bold r-right' : 'r-sm r-right'}>{value}</td>
  </tr>
);

/** A bill (order still open) or a receipt (paid). Every figure is the order's snapshot. */
export function RestaurantReceipt({ payload }: { payload: RestaurantReceiptPayload }) {
  const { order, store, kind } = payload;
  const currency = store.currency;
  const showLogo = store.receipt?.showLogo && Boolean(store.receiptLogoUrl);

  return (
    <PaperFrame store={store}>
      <div className="r-center">
        {showLogo && <img src={store.receiptLogoUrl!} alt="" className="r-logo" />}
        <div className="r-bold" style={{ fontSize: '1.15em' }}>
          {store.receipt?.headerText || store.name}
        </div>
        {store.address && <div className="r-sm">{store.address}</div>}
        {store.phone && <div className="r-sm">Tel: {store.phone}</div>}
        <div className="r-bold" style={{ marginTop: '1.5mm' }}>
          {kind === 'bill' ? 'BILL' : 'RECEIPT'}
        </div>
      </div>

      <div className="r-rule" />

      <table>
        <tbody>
          <Row label="Order" value={order.orderNumber} />
          <Row label={order.type === 'takeaway' ? 'Takeaway' : 'Table'} value={order.type === 'takeaway' ? '—' : order.tableNameSnapshot} />
          <Row
            label="Date"
            value={format(new Date(kind === 'receipt' && order.paidAt ? order.paidAt : order.createdAt), 'dd/MM/yyyy hh:mm a')}
          />
          {store.receipt?.showCashier && <Row label="Served by" value={order.openedByNameSnapshot} />}
          {order.customerNameSnapshot && <Row label="Guest" value={order.customerNameSnapshot} />}
        </tbody>
      </table>

      <div className="r-rule" />

      <table>
        <tbody>
          {order.items.map((line) => (
            <tr key={line._id}>
              <td colSpan={2} style={{ paddingBottom: '1mm' }}>
                <div>{line.nameSnapshot}</div>
                <div className="r-sm" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>
                    {line.quantity} × {formatMoney(line.unitPriceMinor, currency)}
                  </span>
                  <span className="r-bold">{formatMoney(line.lineTotalMinor, currency)}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="r-rule" />

      <table>
        <tbody>
          <Row label="Subtotal" value={formatMoney(order.subtotalMinor, currency)} />
          {order.discountMinor > 0 && <Row label="Discount" value={`-${formatMoney(order.discountMinor, currency)}`} />}
          <tr>
            <td className="r-bold" style={{ fontSize: '1.15em', paddingTop: '1mm' }}>
              TOTAL
            </td>
            <td className="r-bold r-right" style={{ fontSize: '1.15em', paddingTop: '1mm' }}>
              {formatMoney(order.totalMinor, currency)}
            </td>
          </tr>
          {kind === 'receipt' &&
            order.payments.map((payment, index) => (
              <Row key={`${payment.method}-${index}`} label={`Paid (${payment.method})`} value={formatMoney(payment.amountMinor, currency)} />
            ))}
          {kind === 'receipt' && order.changeMinor > 0 && <Row label="Change" value={formatMoney(order.changeMinor, currency)} />}
        </tbody>
      </table>

      <div className="r-rule" />

      <div className="r-center r-sm">
        {kind === 'bill' ? (
          <div className="r-bold">This is not a receipt. Please pay at the counter.</div>
        ) : (
          store.receipt?.footerText && <div className="r-bold">{store.receipt.footerText}</div>
        )}
        <div style={{ marginTop: '2mm' }}>. . .</div>
      </div>
    </PaperFrame>
  );
}

/** A kitchen order ticket: large, no prices, voids called out. */
export function KitchenTicketSlip({ payload }: { payload: KitchenTicketPayload }) {
  const { ticket, order, store } = payload;
  return (
    <PaperFrame store={store}>
      <div className="r-center">
        <div className="r-sm">{store.name}</div>
        <div className="r-bold" style={{ fontSize: '1.3em' }}>
          KITCHEN · {ticket.ticketNumber}
        </div>
        <div className="r-bold" style={{ fontSize: '1.6em', marginTop: '1mm' }}>
          {order.type === 'takeaway' ? 'TAKEAWAY' : `TABLE ${order.tableNameSnapshot}`}
        </div>
        <div className="r-sm">
          {order.orderNumber} · {format(new Date(ticket.createdAt), 'hh:mm a')} · {ticket.createdByNameSnapshot}
        </div>
      </div>

      <div className="r-rule" />

      <table>
        <tbody>
          {ticket.lines.map((line) => (
            <tr key={`${line.lineId}-${line.quantity}`}>
              <td style={{ paddingBottom: '1.5mm' }}>
                <div className="r-bold" style={{ fontSize: '1.2em' }}>
                  {line.quantity < 0 ? `VOID ${Math.abs(line.quantity)} × ${line.nameSnapshot}` : `${line.quantity} × ${line.nameSnapshot}`}
                </div>
                {line.note && <div className="r-sm">» {line.note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {order.note && (
        <>
          <div className="r-rule" />
          <div className="r-sm">Order note: {order.note}</div>
        </>
      )}
    </PaperFrame>
  );
}

/**
 * Every Restaurant print - bill, receipt, kitchen ticket, shift report - goes
 * through here, so they all print the same way: straight to the thermal printer
 * through QZ Tray when this computer is set up for it, and the browser dialog
 * otherwise. `documentId` identifies the document so an automatic print happens
 * once and a reprint is deliberate.
 */
function PrintDialog({
  open,
  title,
  onClose,
  loading,
  error,
  onRetry,
  width,
  documentId,
  autoPrint = false,
  afterSale = false,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  width: number | undefined;
  documentId?: string | null;
  autoPrint?: boolean;
  afterSale?: boolean;
  children: React.ReactNode;
}) {
  const host = React.useRef<HTMLDivElement>(null);
  const print = useReceiptPrint({
    host,
    documentId: open ? (documentId ?? title) : null,
    ready: open && !loading && !error,
    autoPrint,
    afterSale,
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md gap-3 p-4" hideClose>
        <div className="no-print flex items-center justify-between">
          <h2 className="font-semibold">{title}</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>
        <div ref={host} className="scrollbar-thin max-h-[65vh] overflow-y-auto rounded-md bg-muted/40 p-3">
          {loading && <LoadingState label="Preparing…" />}
          {error && <ErrorState message="Could not load this document" onRetry={onRetry} />}
          {children}
        </div>
        <ReceiptPrintBar print={print} />
        <div className="no-print">
          <Button
            className="w-full"
            onClick={print.print}
            disabled={loading || error}
            loading={print.direct && print.status === 'printing'}
          >
            <Printer />
            {print.direct ? 'Print' : `Print (${resolveReceiptWidth(width)}mm)`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The Z-report slip: sales, payments, voids and the cash count for one shift. */
export function ShiftZReport({ payload }: { payload: ShiftPayload }) {
  const { shift, report, store } = payload;
  const currency = store.currency;
  const money = (minor: number) => formatMoney(minor, currency);
  const closed = shift.status === 'closed';
  const variance = report.cash.varianceMinor;

  return (
    <PaperFrame store={store}>
      <div className="r-center">
        <div className="r-bold">{store.name}</div>
        <div className="r-bold" style={{ fontSize: '1.2em', marginTop: '1mm' }}>
          {closed ? 'Z-REPORT' : 'X-REPORT (SHIFT OPEN)'}
        </div>
        <div className="r-sm">{shift.shiftNumber}</div>
      </div>

      <div className="r-rule" />
      <table>
        <tbody>
          <Row label="Opened" value={`${format(new Date(shift.openedAt), 'dd/MM/yy hh:mm a')} · ${shift.openedByNameSnapshot}`} />
          {closed && shift.closedAt && (
            <Row label="Closed" value={`${format(new Date(shift.closedAt), 'dd/MM/yy hh:mm a')} · ${shift.closedByNameSnapshot}`} />
          )}
        </tbody>
      </table>

      <div className="r-rule" />
      <table>
        <tbody>
          <Row label="Paid orders" value={String(report.sales.paidOrders)} />
          <Row label="Items sold" value={String(report.sales.itemsSold)} />
          <Row label="Gross sales" value={money(report.sales.grossSalesMinor)} />
          <Row label="Discounts" value={`-${money(report.sales.discountsMinor)}`} />
          <Row label="NET SALES" value={money(report.sales.netSalesMinor)} bold />
          {report.byType.map((row) => (
            <Row key={row.type} label={`  ${row.type === 'dine_in' ? 'Dine-in' : 'Takeaway'} (${row.orders})`} value={money(row.netSalesMinor)} />
          ))}
        </tbody>
      </table>

      <div className="r-rule" />
      <div className="r-bold r-sm">PAYMENTS</div>
      <table>
        <tbody>
          {report.byPaymentMethod.length === 0 && <Row label="None" value="—" />}
          {report.byPaymentMethod.map((row) => (
            <Row key={row.method} label={`${row.method} (${row.count})`} value={money(row.amountMinor)} />
          ))}
        </tbody>
      </table>

      <div className="r-rule" />
      <table>
        <tbody>
          <Row label={`Cancelled orders (${report.cancelled.orders})`} value={money(report.cancelled.valueMinor)} />
          <Row label={`Voided items (${report.voids.quantity})`} value={money(report.voids.valueMinor)} />
          <Row label={`Open orders (${report.openOrders.orders})`} value={money(report.openOrders.valueMinor)} />
        </tbody>
      </table>

      <div className="r-rule" />
      <div className="r-bold r-sm">CASH DRAWER</div>
      <table>
        <tbody>
          <Row label="Opening float" value={money(report.cash.openingFloatMinor)} />
          <Row label="Cash sales" value={money(report.cash.cashSalesMinor)} />
          <Row label="Pay-ins" value={money(report.cash.payInsMinor)} />
          <Row label="Pay-outs" value={`-${money(report.cash.payOutsMinor)}`} />
          <Row label="EXPECTED" value={money(report.cash.expectedCashMinor)} bold />
          {report.cash.countedCashMinor !== null && <Row label="Counted" value={money(report.cash.countedCashMinor)} bold />}
          {variance !== null && (
            <Row label={variance < 0 ? 'SHORT' : variance > 0 ? 'OVER' : 'Variance'} value={money(Math.abs(variance))} bold />
          )}
        </tbody>
      </table>

      {shift.closingNote && (
        <>
          <div className="r-rule" />
          <div className="r-sm">Note: {shift.closingNote}</div>
        </>
      )}
      <div className="r-center r-sm" style={{ marginTop: '2mm' }}>
        Printed {format(new Date(), 'dd/MM/yy hh:mm a')}
      </div>
    </PaperFrame>
  );
}

/** Shows an already-loaded shift report for printing. */
export function ShiftReportDialog({ payload, onClose }: { payload: ShiftPayload | null; onClose: () => void }) {
  return (
    <PrintDialog
      open={Boolean(payload)}
      title={payload?.shift.status === 'closed' ? 'Z-report' : 'Shift report'}
      onClose={onClose}
      loading={false}
      error={false}
      onRetry={() => undefined}
      width={payload?.store.receipt?.paperWidthMm}
      documentId={payload?.shift._id ?? null}
    >
      {payload && <ShiftZReport payload={payload} />}
    </PrintDialog>
  );
}

export function RestaurantReceiptDialog({
  orderId,
  onClose,
  autoPrint = false,
}: {
  orderId: string | null;
  onClose: () => void;
  /** Prints once as soon as the receipt renders - used right after payment. */
  autoPrint?: boolean;
}) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['restaurant', 'receipt', orderId],
    queryFn: () => restaurantApi.receipt(orderId!),
    enabled: Boolean(orderId),
  });
  return (
    <PrintDialog
      open={Boolean(orderId)}
      title={data?.kind === 'bill' ? 'Bill' : 'Receipt'}
      onClose={onClose}
      loading={isLoading}
      error={isError}
      onRetry={() => void refetch()}
      width={data?.store.receipt?.paperWidthMm}
      documentId={orderId}
      autoPrint={autoPrint}
      afterSale={autoPrint}
    >
      {data && <RestaurantReceipt payload={data} />}
    </PrintDialog>
  );
}

export function KitchenTicketDialog({
  target,
  onClose,
}: {
  target: { orderId: string; ticketId: string } | null;
  onClose: () => void;
}) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['restaurant', 'kitchen-ticket', target?.orderId, target?.ticketId],
    queryFn: () => restaurantApi.kitchenTicket(target!.orderId, target!.ticketId),
    enabled: Boolean(target),
  });
  return (
    <PrintDialog
      open={Boolean(target)}
      title="Kitchen ticket"
      onClose={onClose}
      loading={isLoading}
      error={isError}
      onRetry={() => void refetch()}
      width={data?.store.receipt?.paperWidthMm}
      documentId={target ? `${target.orderId}:${target.ticketId}` : null}
    >
      {data && <KitchenTicketSlip payload={data} />}
    </PrintDialog>
  );
}
