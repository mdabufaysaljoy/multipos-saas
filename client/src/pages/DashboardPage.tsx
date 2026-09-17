import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  Boxes,
  Lock,
  PackageX,
  Receipt,
  RotateCcw,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import {
  DASHBOARD_PRESETS,
  RangePicker,
  isRangeReady,
  rangeParams,
  type RangeValue,
} from '@/features/reports/RangePicker';
import { reportApi } from '@/api/endpoints';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

/**
 * The Dashboard answers "how is the shop doing right now?" in one glance.
 *
 * Deliberately NOT a report: no breakdown tables, no sorting, no drill-down.
 * Anything analytical lives on Advanced Analytics, which is what stops the two
 * pages being near-duplicates of each other.
 */
export function DashboardPage() {
  const { activeStore, session } = useAuth();
  const navigate = useNavigate();
  const currency = activeStore?.currency ?? 'BDT';
  const hasAdvanced = session?.entitlement?.features?.advancedReports ?? false;

  const [range, setRange] = React.useState<RangeValue>({ preset: 'today', from: '', to: '' });

  const { data, isLoading, isError } = useQuery({
    queryKey: ['dashboard', 'overview', range],
    queryFn: () => reportApi.overview({ ...rangeParams(range), granularity: 'day' }),
    enabled: isRangeReady(range),
  });

  const kpis = data?.kpis;

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Dashboard"
        description={data ? `${data.range.label} · ${format(parseISO(data.range.from), 'dd MMM')} – ${format(parseISO(data.range.to), 'dd MMM yyyy')}` : 'Business at a glance'}
        actions={
          <Button variant="outline" onClick={() => navigate('/analytics')}>
            Advanced Analytics
            {hasAdvanced ? <ArrowRight /> : <Lock />}
          </Button>
        }
      />

      <RangePicker value={range} onChange={setRange} presets={DASHBOARD_PRESETS} />

      {isLoading && <LoadingState label="Loading your numbers…" />}
      {isError && <EmptyState title="Could not load the dashboard" description="Please try again." />}

      {data && kpis && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi
              icon={<Banknote className="h-4 w-4" />}
              label="Net sales"
              value={formatMoney(kpis.salesMinor, currency)}
              hint={`${kpis.orderCount} order${kpis.orderCount === 1 ? '' : 's'} · ${kpis.itemCount} item${kpis.itemCount === 1 ? '' : 's'}`}
            />
            {kpis.profitMinor === null ? (
              // Profit is Advanced Analytics; the server omits it on other plans.
              <Kpi
                icon={<TrendingUp className="h-4 w-4" />}
                label="Average order"
                value={formatMoney(kpis.averageOrderValueMinor, currency)}
                hint="🔒 Profit analytics on Professional & Enterprise"
              />
            ) : (
              <Kpi
                icon={<TrendingUp className="h-4 w-4" />}
                label="Profit"
                value={formatMoney(kpis.profitMinor, currency)}
                hint={`Avg order ${formatMoney(kpis.averageOrderValueMinor, currency)}`}
                tone={kpis.profitMinor >= 0 ? 'success' : 'destructive'}
              />
            )}
            <Kpi
              icon={<RotateCcw className="h-4 w-4" />}
              label="Returns"
              value={String(kpis.returnCount)}
              hint={`${formatMoney(kpis.returnAmountMinor, currency)} refunded`}
              tone={kpis.returnCount > 0 ? 'warning' : undefined}
            />
            <Kpi
              icon={<Boxes className="h-4 w-4" />}
              label="Stock value"
              value={formatMoney(kpis.stockValueMinor, currency)}
              hint={`${kpis.stockUnits} unit${kpis.stockUnits === 1 ? '' : 's'} on hand`}
            />
          </div>

          {(kpis.lowStockCount > 0 || kpis.outOfStockCount > 0) && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                {kpis.outOfStockCount > 0 && (
                  <strong>{kpis.outOfStockCount} out of stock</strong>
                )}
                {kpis.outOfStockCount > 0 && kpis.lowStockCount > 0 && ' · '}
                {kpis.lowStockCount > 0 && <>{kpis.lowStockCount} running low</>}
              </span>
              <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={() => navigate('/inventory')}>
                Review inventory
              </Button>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Sales trend</CardTitle>
              </CardHeader>
              <CardContent>
                {data.trend.length === 0 ? (
                  <EmptyState title="No sales in this period" className="py-10" />
                ) : (
                  <div className="h-56 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id="dashGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#2563eb" stopOpacity={0.28} />
                            <stop offset="100%" stopColor="#2563eb" stopOpacity={0.02} />
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
                          formatter={(v: number) => [formatMoney(v, currency), 'Sales']}
                        />
                        <Area type="monotone" dataKey="totalMinor" stroke="#2563eb" strokeWidth={2} fill="url(#dashGradient)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wallet className="h-4 w-4" />
                  Payments taken
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.payments.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No payments yet</p>
                ) : (
                  <ul className="space-y-2">
                    {data.payments.map((row) => (
                      <li key={row.method} className="flex items-center justify-between text-sm">
                        <span className="capitalize">{row.method}</span>
                        <span className="tabular font-medium">{formatMoney(row.amountMinor, currency)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Top products</CardTitle>
              </CardHeader>
              <CardContent>
                {data.topProducts.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Nothing sold yet</p>
                ) : (
                  <ul className="divide-y">
                    {data.topProducts.map((product) => (
                      <li key={product.productId} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
                        <span className="min-w-0 flex-1 truncate text-sm">{product.name}</span>
                        <Badge variant="secondary">{product.quantity}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <PackageX className="h-4 w-4" />
                  Running low
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.lowStock.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Stock levels look healthy</p>
                ) : (
                  <ul className="divide-y">
                    {data.lowStock.map((row) => (
                      <li key={row._id} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{row.productNameSnapshot}</p>
                          <p className="truncate text-xs text-muted-foreground">{row.name}</p>
                        </div>
                        <Badge variant="warning">{row.stock} left</Badge>
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
                  Recent sales
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.recentSales.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No sales yet</p>
                ) : (
                  <ul className="divide-y">
                    {data.recentSales.map((sale) => (
                      <li
                        key={sale.id}
                        className="flex cursor-pointer items-center gap-2 py-2 first:pt-0 last:pb-0 hover:bg-accent/40"
                        onClick={() => navigate('/sales')}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-xs">{sale.saleNumber}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {format(new Date(sale.soldAt), 'dd MMM, hh:mm a')} · {sale.customer ?? 'Walk-in'}
                          </p>
                        </div>
                        <span className="tabular text-sm font-medium">{formatMoney(sale.totalMinor, currency)}</span>
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

function Kpi({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: 'success' | 'warning' | 'destructive';
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </div>
        <p
          className={cn(
            'tabular mt-1 text-2xl font-semibold',
            tone === 'success' && 'text-success',
            tone === 'warning' && 'text-warning',
            tone === 'destructive' && 'text-destructive',
          )}
        >
          {value}
        </p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
