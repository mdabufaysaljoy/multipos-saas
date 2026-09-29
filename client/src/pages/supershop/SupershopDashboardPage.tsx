import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { ArrowRight, Boxes, CreditCard, Package, Receipt, RotateCcw, TrendingUp, Wallet } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { DASHBOARD_PRESETS, RangePicker, isRangeReady, rangeParams, type RangeValue } from '@/features/reports/RangePicker';
import { supershopApi } from '@/api/supershop';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { formatQuantity } from '@/lib/supershop';
import { useAuth } from '@/hooks/useAuth';
import type { ShopDashboard } from '@/types/supershop';

/**
 * The Super Shop dashboard: a quick look at the branch, not a report.
 *
 * Laid out like Clothing's so an owner who runs both reads them the same way -
 * four headline figures, the shape of the period, what the drawer took, and the
 * three lists a shopkeeper actually acts on. Detail lives in Advanced
 * Analytics; this screen deliberately does not try to be it.
 *
 * `netSalesMinor` is what was KEPT (charged less refunded) and profit has VAT
 * taken out, because a Super Shop price includes it.
 */
export function SupershopDashboardPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const money = (minor: number) => formatMoney(minor, currency);
  const [range, setRange] = React.useState<RangeValue>({ preset: 'today', from: '', to: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['supershop', 'dashboard', range],
    queryFn: () => supershopApi.dashboard(rangeParams(range)),
    enabled: isRangeReady(range),
  });

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Dashboard"
        description={
          data
            ? `${data.range.label} · ${format(parseISO(data.range.from), 'dd MMM')} – ${format(parseISO(data.range.to), 'dd MMM yyyy')}`
            : 'Today at this branch'
        }
        actions={
          <Button variant="outline" asChild>
            <Link to="/analytics">
              Advanced Analytics
              <ArrowRight />
            </Link>
          </Button>
        }
      />

      <RangePicker value={range} onChange={setRange} presets={DASHBOARD_PRESETS} />

      {isLoading && <LoadingState label="Loading the branch…" />}
      {!isLoading && data && <DashboardBody data={data} currency={currency} money={money} />}
    </div>
  );
}

function DashboardBody({ data, currency, money }: { data: ShopDashboard; currency: string; money: (minor: number) => string }) {
  const k = data.kpis;

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          icon={<Wallet className="h-4 w-4" />}
          label="Net sales"
          value={money(k.netSalesMinor)}
          hint={`${k.salesCount} sale${k.salesCount === 1 ? '' : 's'} · ${k.unitsSold} piece${k.unitsSold === 1 ? '' : 's'}`}
        />
        <Kpi
          icon={<TrendingUp className="h-4 w-4" />}
          label="Profit"
          value={money(k.grossProfitMinor)}
          hint={`Average basket ${money(k.averageSaleMinor)}`}
          tone="text-success"
        />
        <Kpi
          icon={<RotateCcw className="h-4 w-4" />}
          label="Refunds"
          value={String(k.refundCount)}
          hint={`${money(k.refundedMinor)} given back`}
        />
        <Kpi
          icon={<Boxes className="h-4 w-4" />}
          label="Stock value"
          value={money(data.stock.valueMinor)}
          hint={`${data.stock.productCount} product${data.stock.productCount === 1 ? '' : 's'} on hand`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Sales trend</CardTitle>
          </CardHeader>
          <CardContent>
            {data.trend.length === 0 ? (
              <EmptyState title="No sales in this period" className="py-12" />
            ) : (
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="shopDashboardGradient" x1="0" y1="0" x2="0" y2="1">
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
                      formatter={(v: number) => [money(v), 'Charged']}
                    />
                    <Area type="monotone" dataKey="netSalesMinor" stroke="#2563eb" strokeWidth={2} fill="url(#shopDashboardGradient)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <CreditCard className="h-4 w-4" />
              Payments taken
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.payments.length === 0 ? (
              <EmptyState title="No payments yet" className="py-10" />
            ) : (
              <dl className="space-y-2 text-sm">
                {data.payments.map((row) => (
                  <div key={row.method} className="flex justify-between gap-3">
                    <dt className="truncate capitalize">{row.method}</dt>
                    <dd className="tabular shrink-0 font-medium">{money(row.amountMinor)}</dd>
                  </div>
                ))}
                <p className="pt-1 text-xs text-muted-foreground">Cash is shown net of the change handed back.</p>
              </dl>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Package className="h-4 w-4" />
              Top products
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.topProducts.length === 0 ? (
              <EmptyState title="Nothing sold yet" className="py-8" />
            ) : (
              <ul className="space-y-2 text-sm">
                {data.topProducts.map((row) => (
                  <li key={String(row.productId)} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate">{row.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatQuantity(row.quantity, row.unitType)}</span>
                    <span className="tabular shrink-0 font-medium">{money(row.totalMinor)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="h-4 w-4" />
              Running low
              {data.lowStockCount > 0 && <span className="text-xs font-normal text-muted-foreground">({data.lowStockCount})</span>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.lowStock.length === 0 ? (
              <EmptyState title="Stock levels look healthy" className="py-8" />
            ) : (
              <ul className="space-y-2 text-sm">
                {data.lowStock.map((row) => (
                  <li key={String(row.productId)} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate">{row.name}</span>
                    <span className="tabular shrink-0 text-xs text-destructive">
                      {formatQuantity(row.quantityOnHand, row.unitType)} left
                    </span>
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
              <EmptyState title="No sales yet" className="py-8" />
            ) : (
              <ul className="space-y-2 text-sm">
                {data.recentSales.map((row) => (
                  <li key={row._id} className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{row.saleNumber}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {format(parseISO(row.soldAt), 'HH:mm')} · {row.customerNameSnapshot || row.cashierNameSnapshot}
                      </p>
                    </div>
                    <span className="tabular shrink-0 font-medium">{money(row.totalMinor)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
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
  hint: string;
  tone?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </p>
        <p className={`mt-1 text-2xl font-semibold ${tone ?? ''}`}>{value}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
