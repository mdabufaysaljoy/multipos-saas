import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, History } from 'lucide-react';
import { loyaltyApi } from '@/api/endpoints';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LoadingState } from '@/components/states';
import { formatMoney } from '@/lib/money';
import type { Customer } from '@/types/domain';
import { IssueMembershipDialog } from './IssueMembershipDialog';
import { LoyaltyCardPrintDialog } from './LoyaltyCardPrintDialog';
import type { LoyaltyCardData } from './LoyaltyCardSticker';
import { MemberDetailDialog } from './MemberDetailDialog';
import { useLoyaltyAccess } from './useLoyaltyAccess';

/** A customer's loyalty membership, from the customer screen. Shows nothing loyalty-related for a customer without a card. */
export function CustomerLoyaltyDialog({ customer, currency, onClose }: { customer: Customer | null; currency: string; onClose: () => void }) {
  const { canView, canManage } = useLoyaltyAccess();
  const [historyFor, setHistoryFor] = React.useState<string | null>(null);
  const [issueOpen, setIssueOpen] = React.useState(false);
  const [printCard, setPrintCard] = React.useState<LoyaltyCardData | null>(null);

  const { data: member, isLoading } = useQuery({
    queryKey: ['loyalty', 'customer', customer?._id],
    queryFn: () => loyaltyApi.forCustomer(customer!._id),
    enabled: Boolean(customer),
  });

  const hidden = Boolean(historyFor) || issueOpen || Boolean(printCard);

  return (
    <>
      <Dialog open={Boolean(customer) && !hidden} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Loyalty Membership</DialogTitle>
            <DialogDescription>
              {customer?.name} · {customer?.phone}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <LoadingState label="Loading…" />
          ) : member ? (
            <dl className="space-y-1.5 text-sm">
              <Row label="Status">
                <Badge variant={member.status === 'active' ? 'success' : 'secondary'}>{member.status === 'active' ? 'Active' : 'Inactive'}</Badge>
              </Row>
              <Row label="Card ID">
                <span className="font-mono">{member.cardNumber}</span>
              </Row>
              <Row label="Points">
                <span className="tabular font-semibold">{member.pointsBalance.toLocaleString()}</span>
              </Row>
              <Row label="Value">
                <span className="tabular">{formatMoney(member.valueMinor, currency)}</span>
              </Row>
              <Row label="Issued">{new Date(member.issuedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</Row>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">This customer has no loyalty card, so purchases do not earn points.</p>
          )}

          <DialogFooter className="flex-wrap gap-2">
            {member && canView && (
              <Button variant="outline" size="sm" onClick={() => setHistoryFor(member.id)}>
                <History />
                View point history
              </Button>
            )}
            {member && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPrintCard({ cardNumber: member.cardNumber, barcode: member.barcode, customerName: member.customer?.name ?? '', phone: member.customer?.phone ?? '', email: member.customer?.email })}
              >
                Print card
              </Button>
            )}
            {!isLoading && (!member || member.status !== 'active') && canManage && (
              <Button size="sm" onClick={() => setIssueOpen(true)}>
                <CreditCard />
                Issue card
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MemberDetailDialog memberId={historyFor} currency={currency} onClose={() => setHistoryFor(null)} />
      <IssueMembershipDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        customer={customer}
        onIssued={(issued) =>
          setPrintCard({ cardNumber: issued.cardNumber, barcode: issued.barcode, customerName: issued.customer?.name ?? '', phone: issued.customer?.phone ?? '', email: issued.customer?.email })
        }
      />
      <LoyaltyCardPrintDialog card={printCard} onClose={() => setPrintCard(null)} />
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
