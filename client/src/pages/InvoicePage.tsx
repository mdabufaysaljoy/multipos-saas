import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { format } from 'date-fns';
import { ArrowLeft, Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, LoadingState } from '@/components/states';
import { invoiceApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { INVOICE_KIND_LABEL, INVOICE_STATUS, PAYMENT_METHOD_LABEL } from '@/features/billing/billingLabels';

const day = (value: string | null | undefined) => (value ? format(new Date(value), 'd MMM yyyy') : '—');

/**
 * One invoice, laid out to print (or save as PDF from the print dialog).
 * Everything shown is the invoice's own snapshot from when it was issued.
 */
export function InvoicePage() {
  const { invoiceId = '' } = useParams<{ invoiceId: string }>();
  const navigate = useNavigate();
  const { data: invoice, isLoading, isError } = useQuery({
    queryKey: ['account', 'invoice', invoiceId],
    queryFn: () => invoiceApi.accountInvoice(invoiceId),
    enabled: Boolean(invoiceId),
  });

  if (isLoading) return <LoadingState label="Loading invoice…" />;
  if (isError || !invoice) {
    return (
      <div className="p-6">
        <EmptyState title="Invoice not found" />
      </div>
    );
  }

  const money = (minor: number) => formatMoney(minor, invoice.currency);
  const badge = INVOICE_STATUS[invoice.status] ?? { label: invoice.status, variant: 'secondary' as const };

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => navigate('/billing?tab=invoices')}>
          <ArrowLeft />
          Back to invoices
        </Button>
        <Button size="sm" onClick={() => window.print()}>
          <Printer />
          Print or save as PDF
        </Button>
      </div>

      <article id="invoice-print-area" className="mx-auto max-w-3xl space-y-6 rounded-lg border bg-card p-6 text-sm sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-lg font-semibold">{invoice.issuer.name}</p>
            {invoice.issuer.address && <p className="whitespace-pre-line text-muted-foreground">{invoice.issuer.address}</p>}
            {invoice.issuer.email && <p className="text-muted-foreground">{invoice.issuer.email}</p>}
            {invoice.issuer.phone && <p className="text-muted-foreground">{invoice.issuer.phone}</p>}
          </div>
          <div className="space-y-1 text-right">
            <p className="text-xl font-semibold tracking-wide">INVOICE</p>
            <p className="font-mono">{invoice.number}</p>
            <p className="text-muted-foreground">Issued {day(invoice.issuedAt)}</p>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
        </header>

        <section className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-0.5">
            <p className="text-xs font-medium uppercase text-muted-foreground">Billed to</p>
            <p className="font-medium">{invoice.billedTo.accountName}</p>
            <p>Workspace: {invoice.billedTo.workspaceName}</p>
            {invoice.billedTo.email && <p>{invoice.billedTo.email}</p>}
            {invoice.billedTo.phone && <p>{invoice.billedTo.phone}</p>}
          </div>
          <div className="space-y-0.5 sm:text-right">
            <p className="text-xs font-medium uppercase text-muted-foreground">Payment</p>
            <p>{PAYMENT_METHOD_LABEL[invoice.payment.method] ?? invoice.payment.method}</p>
            {invoice.payment.reference && <p className="font-mono text-xs break-all">{invoice.payment.reference}</p>}
            <p>Paid {day(invoice.payment.paidAt)}</p>
            <p className="text-muted-foreground">{INVOICE_KIND_LABEL[invoice.kind] ?? invoice.kind}</p>
          </div>
        </section>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px]">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 font-medium">Description</th>
                <th className="py-2 font-medium">Period</th>
                <th className="py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line, index) => (
                <tr key={index} className="border-b">
                  <td className="py-2">{line.description}</td>
                  <td className="py-2">
                    {day(line.periodStart)} – {day(line.periodEnd)}
                  </td>
                  <td className="py-2 text-right tabular-nums">{money(line.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="ml-auto w-full max-w-xs space-y-1 tabular-nums">
          <Row label="Subtotal" value={money(invoice.subtotalMinor)} />
          {invoice.discountMinor > 0 && <Row label={`Discount${invoice.couponCode ? ` (${invoice.couponCode})` : ''}`} value={`−${money(invoice.discountMinor)}`} />}
          {invoice.creditMinor > 0 && <Row label="Credit for unused time" value={`−${money(invoice.creditMinor)}`} />}
          {invoice.adjustmentMinor !== 0 && (
            <Row label="Adjustment" value={invoice.adjustmentMinor > 0 ? money(invoice.adjustmentMinor) : `−${money(-invoice.adjustmentMinor)}`} />
          )}
          <Row label="Total paid" value={money(invoice.totalMinor)} strong />
          {invoice.refundedMinor > 0 && (
            <>
              <Row label="Refunded" value={`−${money(invoice.refundedMinor)}`} />
              <Row label="Net" value={money(invoice.netMinor)} strong />
            </>
          )}
        </dl>

        {invoice.refunds.length > 0 && (
          <section className="space-y-1">
            <p className="text-xs font-medium uppercase text-muted-foreground">Refunds</p>
            <ul className="space-y-0.5">
              {invoice.refunds.map((refund, index) => (
                <li key={index}>
                  {day(refund.at)} · {money(refund.amountMinor)} · {PAYMENT_METHOD_LABEL[refund.method] ?? refund.method}
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="border-t pt-3 text-xs text-muted-foreground">All amounts in {invoice.currency}.</footer>
      </article>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? 'flex justify-between border-t pt-1 font-semibold' : 'flex justify-between'}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
