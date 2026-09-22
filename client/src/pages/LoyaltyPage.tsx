import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, Plus, Settings } from 'lucide-react';
import { loyaltyApi, storeApi } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { IssueMembershipDialog } from '@/features/loyalty/IssueMembershipDialog';
import { LoyaltyCardPrintDialog } from '@/features/loyalty/LoyaltyCardPrintDialog';
import { LoyaltyLocked } from '@/features/loyalty/LoyaltyLocked';
import { MemberDetailDialog } from '@/features/loyalty/MemberDetailDialog';
import { useLoyaltyAccess } from '@/features/loyalty/useLoyaltyAccess';
import type { LoyaltyCardData } from '@/features/loyalty/LoyaltyCardSticker';
import { useAuth } from '@/hooks/useAuth';
import { formatMoney } from '@/lib/money';
import type { LoyaltyMember } from '@/types/domain';

/** Loyalty members of the current branch: cards, points, history, printing. */
export function LoyaltyPage() {
  const { activeStore, can } = useAuth();
  const access = useLoyaltyAccess();
  const currency = activeStore?.currency ?? 'BDT';

  const [page, setPage] = React.useState(1);
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);
  const [status, setStatus] = React.useState<'all' | 'active' | 'inactive'>('all');
  const [issueOpen, setIssueOpen] = React.useState(false);
  const [openMember, setOpenMember] = React.useState<string | null>(null);
  const [printCard, setPrintCard] = React.useState<LoyaltyCardData | null>(null);

  const { data: config } = useQuery({ queryKey: ['store', 'pos-config'], queryFn: storeApi.posConfig, enabled: access.canView });
  const programOn = config?.loyalty?.available === true;

  const { data: summary, error: summaryError } = useQuery({
    queryKey: ['loyalty', 'summary'],
    queryFn: loyaltyApi.summary,
    enabled: access.canView,
  });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['loyalty', 'members', page, search, status],
    queryFn: () => loyaltyApi.list({ page, limit: 20, search, ...(status !== 'all' ? { status } : {}) }),
    enabled: access.canView,
  });

  React.useEffect(() => setPage(1), [search, status]);

  // The server is the authority: a plan change since sign-in shows the locked state too.
  const locked = !access.inPlan || (summaryError instanceof ApiError && summaryError.code === 'ENTITLEMENT_REQUIRED');
  if (locked) {
    return (
      <div className="p-4 lg:p-6">
        <LoyaltyLocked />
      </div>
    );
  }
  if (!access.canView) {
    return (
      <div className="p-4 lg:p-6">
        <Card className="mx-auto max-w-xl">
          <CardContent className="p-6 text-center text-sm text-muted-foreground">You do not have permission to view loyalty members.</CardContent>
        </Card>
      </div>
    );
  }

  const columns: Column<LoyaltyMember>[] = [
    {
      key: 'customer',
      mobile: 'title',
      header: 'Member',
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.customer?.name ?? '—'}</p>
          <p className="truncate text-xs text-muted-foreground">{row.customer?.phone}</p>
        </div>
      ),
    },
    { key: 'card', mobile: 'meta', header: 'Card', cell: (row) => <span className="font-mono text-xs">{row.cardNumber}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <Badge variant={row.status === 'active' ? 'success' : 'secondary'}>{row.status === 'active' ? 'Active' : 'Inactive'}</Badge>,
    },
    { key: 'points', header: 'Points', className: 'text-right', headerClassName: 'text-right', cell: (row) => <span className="tabular font-semibold">{row.pointsBalance.toLocaleString()}</span> },
    { key: 'value', header: 'Value', className: 'text-right', headerClassName: 'text-right', cell: (row) => <span className="tabular">{formatMoney(row.valueMinor, currency)}</span> },
    {
      key: 'issued',
      header: 'Issued',
      cell: (row) => <span className="text-sm text-muted-foreground">{new Date(row.issuedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</span>,
    },
  ];

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Loyalty"
        description="Membership cards with barcodes. Only a scanned card earns or redeems points."
        actions={
          access.canManage ? (
            <Button onClick={() => setIssueOpen(true)} disabled={!programOn}>
              <Plus />
              Issue card
            </Button>
          ) : undefined
        }
      />

      {config && !programOn && (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="flex flex-col gap-2 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span>The loyalty program is switched off for this branch. Cards cannot be issued or used until it is turned on.</span>
            {can('settings.edit') && (
              <Button asChild variant="outline" size="sm">
                <Link to="/settings?tab=loyalty">
                  <Settings />
                  Loyalty settings
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Loyalty members" value={summary?.totalMembers} />
        <Metric label="Active cards" value={summary?.activeCards} />
        <Metric label="Points issued" value={summary?.pointsIssued} />
        <Metric label="Points redeemed" value={summary?.pointsRedeemed} />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <SearchInput value={term} onChange={setTerm} placeholder="Search name, phone or card number…" className="sm:max-w-sm" />
        <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All cards</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(row) => row.id}
          loading={isLoading}
          error={error ? (error as Error).message : null}
          onRetry={() => void refetch()}
          meta={data?.meta}
          onPageChange={setPage}
          onRowClick={(row) => setOpenMember(row.id)}
          emptyTitle="No loyalty members yet"
          emptyDescription="Issue a card to an existing customer to start earning points."
          emptyAction={
            access.canManage && programOn ? (
              <Button onClick={() => setIssueOpen(true)}>
                <CreditCard />
                Issue the first card
              </Button>
            ) : undefined
          }
        />
      </Card>

      <IssueMembershipDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        onIssued={(member) =>
          setPrintCard({ cardNumber: member.cardNumber, barcode: member.barcode, customerName: member.customer?.name ?? '', phone: member.customer?.phone ?? '', email: member.customer?.email })
        }
      />
      <MemberDetailDialog memberId={openMember} currency={currency} onClose={() => setOpenMember(null)} />
      <LoyaltyCardPrintDialog card={printCard} onClose={() => setPrintCard(null)} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="tabular text-xl font-semibold">{value === undefined ? '—' : value.toLocaleString()}</p>
      </CardContent>
    </Card>
  );
}
