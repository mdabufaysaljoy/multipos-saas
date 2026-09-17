import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/PageHeader';
import { WalletPanel } from '@/features/billing/WalletPanel';
import { billingApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';

/**
 * Wallet, promoted to its own top-level section.
 *
 * It used to live as a tab inside Subscription, which buried the balance and
 * made topping up feel like a billing side-effect. Account history now sits
 * here too, since payments and plan events are the record of what the money
 * was spent on.
 */
export function WalletPage() {
  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader title="Wallet" description="Your prepaid balance for subscriptions, SMS and email." />

      <Tabs defaultValue="wallet">
        <TabsList>
          <TabsTrigger value="wallet">Balance &amp; activity</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="wallet">
          <WalletPanel />
        </TabsContent>

        <TabsContent value="history">
          <AccountHistory />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Payments taken and subscription events, in one chronological record. */
function AccountHistory() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const { data } = useQuery({ queryKey: ['subscription', 'history'], queryFn: billingApi.history });

  const events = (data?.events ?? []) as {
    _id: string;
    type: string;
    message: string;
    createdAt: string;
    actorNameSnapshot: string;
  }[];
  const payments = (data?.payments ?? []) as {
    _id: string;
    amountMinor: number;
    currency: string;
    provider: string;
    status: string;
    paidAt: string | null;
    createdAt: string;
    providerReference: string | null;
  }[];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Payments</CardTitle>
        </CardHeader>
        <CardContent>
          {payments.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No payments yet</p>
          ) : (
            <ul className="divide-y">
              {payments.map((payment) => (
                <li key={payment._id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{formatMoney(payment.amountMinor, payment.currency || currency)}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {format(new Date(payment.paidAt ?? payment.createdAt), 'd MMM yyyy')} · {payment.provider}
                      {payment.providerReference ? ` · ${payment.providerReference}` : ''}
                    </p>
                  </div>
                  <Badge variant={payment.status === 'paid' ? 'success' : payment.status === 'pending' ? 'warning' : 'destructive'}>
                    {payment.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Subscription events</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No history yet</p>
          ) : (
            <ul className="divide-y">
              {events.map((event) => (
                <li key={event._id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                  <Badge variant="secondary" className="mt-0.5 shrink-0">
                    {event.type.replace(/_/g, ' ')}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{event.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(event.createdAt), 'd MMM yyyy, hh:mm a')} · {event.actorNameSnapshot}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
