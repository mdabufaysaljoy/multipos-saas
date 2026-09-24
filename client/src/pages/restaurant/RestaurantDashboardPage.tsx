import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Armchair,
  ArrowRight,
  Banknote,
  ClipboardList,
  Receipt,
  ShoppingBag,
  Soup,
  Users,
  Wallet,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { DASHBOARD_PRESETS, RangePicker, isRangeReady, rangeParams, type RangeValue } from '@/features/reports/RangePicker';
import { DashboardKpi } from '@/features/reports/DashboardKpi';
import { restaurantApi } from '@/api/restaurant';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';

const ORDER_STATUS: Record<string, { label: string; variant: 'warning' | 'success' | 'secondary' }> = {
  open: { label: 'Open', variant: 'warning' },
  paid: { label: 'Paid', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'secondary' },
};

/**
 * "How is the restaurant doing?" at a glance, for the current branch.
 *
 * Trading figures follow the chosen range; the floor panel is always now.
 */
export function RestaurantDashboardPage() {
  const { activeStore, can } = useAuth();
  const navigate = useNavigate();
  const currency = activeStore?.currency ?? 'BDT';
  const [range, setRange] = React.useState<RangeValue>({ preset: 'today', from: '', to: '' });

  const { data, isLoading, isError } = useQuery({
    queryKey: ['restaurant', 'dashboard', range],
    queryFn: () => restaurantApi.dashboard(rangeParams(range)),
    enabled: isRangeReady(range),
    // The floor changes as orders are taken; keep it reasonably fresh.
    refetchInterval: 60_000,
  });

  const kpis = data?.kpis;
  const typeTotal = (data?.byType ?? []).reduce((sum, row) => sum + row.revenueMinor, 0);
  const methodTotal = (data?.byPaymentMethod ?? []).reduce((sum, row) => sum + row.amountMinor, 0);

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Dashboard"
        description={
          data
            ? `${data.range.label} · ${format(parseISO(data.range.from), 'dd MMM')} – ${format(parseISO(data.range.to), 'dd MMM yyyy')}`
            : 'Your restaurant at a glance'
        }
        actions={
          can('sales.create') ? (
            <Button variant="outline" onClick={() => navigate('/pos')}>
              Open POS
              <ArrowRight />
            </Button>
          ) : undefined
        }
      />

      <RangePicker value={range} onChange={setRange} presets={DASHBOARD_PRESETS} />

      {isLoading && <LoadingState label="Loading your numbers…" />}
      {isError && <EmptyState title="Could not load the dashboard" description="Please try again." />}

      {data && kpis && (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <DashboardKpi
              icon={<Banknote className="h-4 w-4" />}
              label="Revenue"
              value={formatMoney(kpis.revenueMinor, currency)}
              now={kpis.revenueMinor}
              before={data.previous.revenueMinor}
            />
            <DashboardKpi
              icon={<Receipt className="h-4 w-4" />}
              label="Paid orders"
              value={String(kpis.paidOrders)}
              now={kpis.paidOrders}
              before={data.previous.paidOrders}
            />
            <DashboardKpi
              icon={<Wallet className="h-4 w-4" />}
              label="Average order"
              value={formatMoney(kpis.averageOrderMinor, currency)}
              now={kpis.averageOrderMinor}
              before={data.previous.averageOrderMinor}
            />
            <DashboardKpi
              icon={<Soup className="h-4 w-4" />}
              label="Items sold"
              value={String(kpis.itemsSold)}
              hint={`${formatMoney(kpis.discountsMinor, currency)} discounts · ${kpis.cancelledOrders} cancelled`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border bg-card px-4 py-3 text-sm">
            <span className="flex items-center gap-2 font-medium">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              Right now
            </span>
            <span className="flex items-center gap-1.5">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
              <strong className="tabular">{data.live.openOrders}</strong> open order{data.live.openOrders === 1 ? '' : 's'} worth{' '}
              <strong className="tabular">{formatMoney(data.live.openOrdersValueMinor, currency)}</strong>
            </span>
            <span className="flex items-center gap-1.5">
              <Armchair className="h-4 w-4 text-muted-foreground" />
              <strong className="tabular">{data.live.occupiedTables}</strong> of {data.live.tables} tables occupied
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  Revenue {data.range.bucket === 'hour' ? 'by hour' : data.range.bucket === 'day' ? 'by day' : 'by month'}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.trend.length === 0 ? (
                  <EmptyState title="No paid orders in this period" className="py-10" />
                ) : (
                  <div className="h-56 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id="restaurantGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#ea580c" stopOpacity={0.28} />
                            <stop offset="100%" stopColor="#ea580c" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                        <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
                        <YAxis
                          tickFormatter={(v: number) => formatMoneyCompact(v, currency)}
                          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                          tickLine={false}
                          axisLine={false}
                          width={60}
                        />
                        <Tooltip
                          contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
                          formatter={(v: number) => [formatMoney(v, currency), 'Revenue']}
                        />
                        <Area type="monotone" dataKey="revenueMinor" stroke="#ea580c" strokeWidth={2} fill="url(#restaurantGradient)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShoppingBag className="h-4 w-4" />
                  Dine-in vs takeaway
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.byType.map((row) => (
                  <ShareBar
                    key={row.type}
                    label={`${row.type === 'dine_in' ? 'Dine-in' : 'Takeaway'} · ${row.orders} order${row.orders === 1 ? '' : 's'}`}
                    value={formatMoney(row.revenueMinor, currency)}
                    share={typeTotal > 0 ? row.revenueMinor / typeTotal : 0}
                  />
                ))}
                <div className="border-t pt-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payments</p>
                  {data.byPaymentMethod.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No payments yet</p>
                  ) : (
                    <div className="space-y-2">
                      {data.byPaymentMethod.map((row) => (
                        <ShareBar
                          key={row.method}
                          label={row.method}
                          value={formatMoney(row.amountMinor, currency)}
                          share={methodTotal > 0 ? row.amountMinor / methodTotal : 0}
                          capitalize
                        />
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Soup className="h-4 w-4" />
                  Best sellers
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.topItems.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Nothing sold yet</p>
                ) : (
                  <ul className="divide-y">
                    {data.topItems.map((item) => (
                      <li key={item.menuItemId} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
                        <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                        <Badge variant="secondary">{item.quantity}</Badge>
                        <span className="tabular w-24 text-right text-sm">{formatMoney(item.revenueMinor, currency)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="h-4 w-4" />
                  Staff sales
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.byStaff.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No payments taken yet</p>
                ) : (
                  <ul className="divide-y">
                    {data.byStaff.map((row, index) => (
                      <li key={row.userId ?? index} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
                        <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
                        <span className="text-xs text-muted-foreground">{row.orders} orders</span>
                        <span className="tabular w-24 text-right text-sm font-medium">{formatMoney(row.revenueMinor, currency)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Receipt className="h-4 w-4" />
                  Recent orders
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.recentOrders.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No orders yet</p>
                ) : (
                  <ul className="divide-y">
                    {data.recentOrders.map((order) => (
                      <li
                        key={order._id}
                        className="flex cursor-pointer items-center gap-2 py-2 first:pt-0 last:pb-0 hover:bg-accent/40"
                        onClick={() => navigate('/orders')}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-xs">{order.orderNumber}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {format(new Date(order.createdAt), 'hh:mm a')} ·{' '}
                            {order.type === 'takeaway' ? 'Takeaway' : `Table ${order.tableNameSnapshot}`}
                          </p>
                        </div>
                        <Badge variant={ORDER_STATUS[order.status].variant}>{ORDER_STATUS[order.status].label}</Badge>
                        <span className="tabular w-20 text-right text-sm font-medium">{formatMoney(order.totalMinor, currency)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function ShareBar({ label, value, share, capitalize }: { label: string; value: string; share: number; capitalize?: boolean }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className={cn(capitalize && 'capitalize')}>{label}</span>
        <span className="tabular font-medium">{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
    </div>
  );
}
