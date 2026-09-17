import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { format } from 'date-fns';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState, LoadingState } from '@/components/states';
import { statementApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { PAYMENT_METHOD_LABEL } from '@/features/billing/billingLabels';

/**
 * A wallet top-up receipt, laid out to print. The account owner opens it by
 * receipt id from Billing; a workspace user opens their own top-up's receipt.
 */
export function ReceiptPage({ source }: { source: 'account' | 'workspace' }) {
  const { receiptId = '', topUpId = '' } = useParams<{ receiptId: string; topUpId: string }>();
  const navigate = useNavigate();
  const id = source === 'account' ? receiptId : topUpId;
  const { data: receipt, isLoading, isError } = useQuery({
    queryKey: ['receipt', source, id],
    queryFn: () => (source === 'account' ? statementApi.receipt(id) : statementApi.topUpReceipt(id)),
    enabled: Boolean(id),
  });

  if (isLoading) return <LoadingState label="Loading receipt…" />;
  if (isError || !receipt) {
    return (
      <div className="p-6">
        <EmptyState title="Receipt not found" description="A receipt is issued once a top-up has been approved." />
      </div>
    );
  }

  const money = (minor: number) => formatMoney(minor, receipt.currency);

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => navigate(source === 'account' ? '/billing?tab=statement' : '/wallet')}>
          <ArrowLeft />
          Back
        </Button>
        <Button size="sm" onClick={() => window.print()}>
          <Printer />
          Print or save as PDF
        </Button>
      </div>

      <article id="wallet-receipt-print-area" className="mx-auto max-w-xl space-y-6 rounded-lg border bg-card p-6 text-sm sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-lg font-semibold">{receipt.issuer.name}</p>
            {receipt.issuer.address && <p className="whitespace-pre-line text-muted-foreground">{receipt.issuer.address}</p>}
            {receipt.issuer.email && <p className="text-muted-foreground">{receipt.issuer.email}</p>}
            {receipt.issuer.phone && <p className="text-muted-foreground">{receipt.issuer.phone}</p>}
          </div>
          <div className="space-y-1 text-right">
            <p className="text-xl font-semibold tracking-wide">RECEIPT</p>
            <p className="font-mono">{receipt.number}</p>
            <p className="text-muted-foreground">{format(new Date(receipt.issuedAt), 'd MMM yyyy, h:mm a')}</p>
          </div>
        </header>

        <section className="space-y-0.5">
          <p className="text-xs font-medium uppercase text-muted-foreground">Received from</p>
          <p className="font-medium">{receipt.receivedFrom.accountName}</p>
          <p>Workspace: {receipt.receivedFrom.workspaceName}</p>
          {receipt.receivedFrom.email && <p>{receipt.receivedFrom.email}</p>}
        </section>

        <section className="rounded-md border p-4">
          <p className="text-xs font-medium uppercase text-muted-foreground">Wallet top-up</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{money(receipt.amountMinor)}</p>
          <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Paid by</dt>
            <dd>{PAYMENT_METHOD_LABEL[receipt.payment.method] ?? receipt.payment.method}</dd>
            {receipt.payment.senderLast4 && (
              <>
                <dt className="text-muted-foreground">From number</dt>
                <dd className="font-mono">•••• {receipt.payment.senderLast4}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Transaction</dt>
            <dd className="break-all font-mono text-xs">{receipt.payment.transactionId}</dd>
            {receipt.balanceAfterMinor !== null && (
              <>
                <dt className="text-muted-foreground">Wallet balance after</dt>
                <dd className="tabular-nums">{money(receipt.balanceAfterMinor)}</dd>
              </>
            )}
          </dl>
        </section>

        <footer className="border-t pt-3 text-xs text-muted-foreground">
          Money added to the prepaid account wallet. It is spent on subscriptions and usage as recorded on the account statement.
        </footer>
      </article>
    </div>
  );
}

/** Route entries: the lazy loader passes no props, so each source has its own component. */
export function AccountReceiptPage() {
  return <ReceiptPage source="account" />;
}

export function WorkspaceReceiptPage() {
  return <ReceiptPage source="workspace" />;
}
