import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { AlertTriangle, Info, MessageSquare, Send, Users, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { LoadingState } from '@/components/states';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useDebounced } from '@/components/SearchInput';
import { ApiError } from '@/api/client';
import { customerApi, messagingApi, walletApi } from '@/api/endpoints';
import { EmailCampaignTab } from '@/features/marketing/EmailCampaignTab';
import { ChannelUnavailable } from '@/features/marketing/ChannelUnavailable';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import type { SmsCampaign, SmsMessage } from '@/types/domain';

/**
 * Marketing campaigns (SMS and email), billed from the wallet.
 *
 * The cost is quoted live from the server before anything is sent, so the
 * shopkeeper always sees the price - including how Bengali text doubles the
 * segment count - before committing.
 */
export function MarketingPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';

  const { data: status, isLoading } = useQuery({ queryKey: ['messaging', 'status'], queryFn: messagingApi.status });
  const { can: canSeeWallet } = useAuth();
  const { data: wallet } = useQuery({ queryKey: ['wallet'], queryFn: walletApi.balance, enabled: canSeeWallet('wallet.view') });

  if (isLoading || !status) return <LoadingState label="Loading messaging…" />;

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Marketing"
        description="Reach your customers by SMS and email. Charged from your wallet balance."
      />

      {status.sms.includedInPlan && !status.sms.providerConfigured && (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <p className="font-semibold text-warning">SMS sending is not enabled on this server</p>
              <p className="mt-0.5 text-muted-foreground">
                An administrator needs to add the SMS gateway credentials. Until then you can compose and price a
                campaign, but nothing will be sent.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Rates come from Platform Admin configuration, never hardcoded. */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3 p-4">
          <Rate label="SMS rate" value={`${formatMoney(status.sms.perSegmentCostMinor, currency)} / SMS`} />
          <Rate
            label="Email rate"
            value={
              status.email.perEmailCostMinor > 0
                ? `${formatMoney(status.email.perEmailCostMinor, currency)} / email`
                : 'Free'
            }
          />
          <div className="ml-auto flex flex-wrap gap-2">
            <ChannelBadge label="SMS" channel={status.sms} />
            <ChannelBadge label="Email" channel={status.email} />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<Wallet className="h-4 w-4" />} label="Marketing budget (wallet)" value={formatMoney(wallet?.balanceMinor ?? 0, currency)} />
        <Stat icon={<Send className="h-4 w-4" />} label="Messages sent" value={String(status.usage.sent)} />
        <Stat
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Failed"
          value={String(status.usage.failed)}
          tone={status.usage.failed > 0 ? 'warning' : undefined}
        />
        <Stat icon={<MessageSquare className="h-4 w-4" />} label="Spent on SMS" value={formatMoney(status.usage.totalCostMinor, currency)} />
      </div>

      <Tabs defaultValue="sms">
        <TabsList>
          <TabsTrigger value="sms">SMS campaign</TabsTrigger>
          <TabsTrigger value="email">Email campaign</TabsTrigger>
          <TabsTrigger value="history">Campaign history</TabsTrigger>
        </TabsList>

        <TabsContent value="sms">
          <ComposeTab
            currency={currency}
            includedInPlan={status.sms.includedInPlan}
            providerConfigured={status.sms.providerConfigured}
            planName={status.planName}
          />
        </TabsContent>
        <TabsContent value="email">
          <EmailCampaignTab
            currency={currency}
            includedInPlan={status.email.includedInPlan}
            providerConfigured={status.email.providerConfigured}
            planName={status.planName}
            perEmailCostMinor={status.email.perEmailCostMinor}
            walletBalanceMinor={wallet?.balanceMinor ?? 0}
          />
        </TabsContent>
        <TabsContent value="history">
          <div className="space-y-4">
            <CampaignsTab currency={currency} />
            <HistoryTab currency={currency} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ChannelBadge({
  label,
  channel,
}: {
  label: string;
  channel: { includedInPlan: boolean; providerConfigured: boolean };
}) {
  // Three states, not two. "Not configured" on a plan that never included the
  // channel blames the server for a billing decision.
  if (!channel.includedInPlan) return <Badge variant="secondary">{label} not in plan</Badge>;
  if (!channel.providerConfigured) return <Badge variant="warning">{label} setup pending</Badge>;
  return <Badge variant="success">{label} ready</Badge>;
}

function ComposeTab({
  currency,
  includedInPlan,
  providerConfigured,
  planName,
}: {
  currency: string;
  includedInPlan: boolean;
  providerConfigured: boolean;
  planName: string | null;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = React.useState<'campaign' | 'single'>('campaign');
  const [name, setName] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [confirm, setConfirm] = React.useState(false);

  // Hooks above, guard below: a plan that does not include SMS gets the same
  // explanation the email tab gives, rather than a composer that fails on send.


  // Debounced so the estimate does not fire on every keystroke.
  const debounced = useDebounced(message, 400);

  const { data: customerCount } = useQuery({
    queryKey: ['messaging', 'audience'],
    queryFn: async () => {
      const result = await customerApi.list({ limit: 1 });
      return result.meta.total;
    },
  });

  const recipients = mode === 'campaign' ? (customerCount ?? 0) : 1;

  const { data: estimate } = useQuery({
    queryKey: ['messaging', 'estimate', debounced, recipients],
    queryFn: () => messagingApi.estimate({ message: debounced, recipients: Math.max(1, recipients) }),
    enabled: debounced.trim().length > 0,
  });

  const send = useMutation<SmsMessage | SmsCampaign>({
    mutationFn: () =>
      mode === 'campaign'
        ? messagingApi.sendCampaign({ name: name.trim(), message: message.trim(), audience: 'all-customers' })
        : messagingApi.sendOne({ to: phone.trim(), message: message.trim() }),
    onSuccess: () => {
      toast.success(mode === 'campaign' ? 'Campaign sent' : 'Message sent');
      setMessage('');
      setName('');
      setPhone('');
      setConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ['messaging'] });
      void queryClient.invalidateQueries({ queryKey: ['wallet'] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'Could not send');
      setConfirm(false);
    },
  });

  const valid =
    message.trim().length > 0 &&
    (mode === 'campaign' ? name.trim().length >= 2 && recipients > 0 : phone.trim().length >= 10);

  if (!includedInPlan) return <ChannelUnavailable channel="SMS" planName={planName} />;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Compose</CardTitle>
          <CardDescription>Keep it short — every 160 characters is another SMS.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button variant={mode === 'campaign' ? 'default' : 'outline'} size="sm" onClick={() => setMode('campaign')}>
              <Users />
              All customers
            </Button>
            <Button variant={mode === 'single' ? 'default' : 'outline'} size="sm" onClick={() => setMode('single')}>
              <MessageSquare />
              Single number
            </Button>
          </div>

          {mode === 'campaign' ? (
            <div className="space-y-1.5">
              <Label>Campaign name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Eid collection announcement" />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>Phone number</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="01711000000" />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Message</Label>
            <Textarea
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="New collection now in store. Visit us this weekend for 20% off!"
            />
            {estimate && (
              <p className="text-xs text-muted-foreground">
                {estimate.characters} characters · {estimate.segments} SMS ·{' '}
                <span className={cn(estimate.encoding === 'UCS2' && 'font-medium text-warning')}>
                  {estimate.encoding === 'UCS2' ? 'Bengali/Unicode — 70 chars per SMS' : 'English — 160 chars per SMS'}
                </span>
              </p>
            )}
          </div>

          <Button disabled={!valid || !providerConfigured} onClick={() => setConfirm(true)}>
            <Send />
            {mode === 'campaign' ? `Send to ${recipients} customer${recipients === 1 ? '' : 's'}` : 'Send message'}
          </Button>
          {!providerConfigured && (
            <p className="text-xs text-muted-foreground">
              You can compose and price this now. Sending waits on the gateway setup.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Cost</CardTitle>
          <CardDescription>Charged from your wallet when you send.</CardDescription>
        </CardHeader>
        <CardContent>
          {!estimate ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Type a message to see the cost</p>
          ) : (
            <dl className="space-y-1.5 text-sm">
              <Row label="Recipients" value={String(estimate.recipients)} />
              <Row label="SMS per recipient" value={String(estimate.segments)} />
              <Row label="Price per SMS" value={formatMoney(estimate.perSmsCostMinor, currency)} />
              <div className="flex justify-between border-t pt-2 text-base font-semibold">
                <dt>Total</dt>
                <dd className="tabular">{formatMoney(estimate.totalCostMinor, currency)}</dd>
              </div>
            </dl>
          )}

          <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Anything the gateway rejects is refunded to your wallet automatically.
          </p>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={mode === 'campaign' ? `Send to ${recipients} customers?` : 'Send this message?'}
        description={
          <span>
            {formatMoney(estimate?.totalCostMinor ?? 0, currency)} will be deducted from your wallet. This cannot be
            undone once the messages leave.
          </span>
        }
        confirmLabel="Send now"
        loading={send.isPending}
        onConfirm={() => send.mutate()}
      />
    </div>
  );
}

function CampaignsTab({ currency }: { currency: string }) {
  const [page, setPage] = React.useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['messaging', 'campaigns', page],
    queryFn: () => messagingApi.campaigns({ page, limit: 20 }),
  });

  const columns: Column<SmsCampaign>[] = [
    {
      key: 'name',
      header: 'Campaign',
      cell: (row) => (
        <div className="max-w-xs">
          <p className="font-medium">{row.name}</p>
          <p className="truncate text-xs text-muted-foreground">{row.message}</p>
        </div>
      ),
    },
    { key: 'recipients', header: 'Recipients', cell: (row) => <span className="tabular">{row.recipientCount}</span> },
    {
      key: 'result',
      header: 'Delivered',
      cell: (row) => (
        <div className="flex gap-1">
          <Badge variant="success">{row.sentCount} sent</Badge>
          {row.failedCount > 0 && <Badge variant="destructive">{row.failedCount} failed</Badge>}
        </div>
      ),
    },
    {
      key: 'cost',
      header: 'Cost',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => <span className="tabular font-medium">{formatMoney(row.actualCostMinor, currency)}</span>,
    },
    {
      key: 'date',
      header: 'Sent',
      cell: (row) => <span className="text-sm text-muted-foreground">{format(new Date(row.createdAt), 'd MMM, hh:mm a')}</span>,
    },
  ];

  return (
    <Card>
      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row._id}
        loading={isLoading}
        meta={data?.meta}
        onPageChange={setPage}
        emptyTitle="No campaigns yet"
        emptyDescription="Compose a message to reach all your customers at once."
      />
    </Card>
  );
}

function HistoryTab({ currency }: { currency: string }) {
  const [page, setPage] = React.useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['messaging', 'history', page],
    queryFn: () => messagingApi.history({ page, limit: 25 }),
  });

  const columns: Column<SmsMessage>[] = [
    { key: 'to', header: 'Recipient', cell: (row) => <span className="font-mono text-sm">{row.recipient}</span> },
    {
      key: 'message',
      header: 'Message',
      cell: (row) => (
        <div className="max-w-sm">
          <p className="truncate text-sm">{row.message}</p>
          <p className="text-xs text-muted-foreground">
            {row.segments} SMS · {row.encoding}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <div>
          <Badge variant={row.status === 'sent' ? 'success' : row.status === 'failed' ? 'destructive' : 'secondary'}>
            {row.status}
          </Badge>
          {row.error && <p className="mt-0.5 max-w-[200px] truncate text-xs text-destructive">{row.error}</p>}
        </div>
      ),
    },
    {
      key: 'cost',
      header: 'Cost',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => <span className="tabular">{formatMoney(row.costMinor, currency)}</span>,
    },
    {
      key: 'date',
      header: 'When',
      cell: (row) => <span className="text-sm text-muted-foreground">{format(new Date(row.createdAt), 'd MMM, hh:mm a')}</span>,
    },
  ];

  return (
    <Card>
      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row._id}
        loading={isLoading}
        meta={data?.meta}
        onPageChange={setPage}
        emptyTitle="No messages sent yet"
      />
    </Card>
  );
}

function Rate({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="tabular text-lg font-semibold">{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}

function Stat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: 'warning' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </div>
        <p className={cn('tabular mt-1 text-2xl font-semibold', tone === 'warning' && 'text-warning')}>{value}</p>
      </CardContent>
    </Card>
  );
}
