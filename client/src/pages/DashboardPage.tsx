import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Banknote,
  Package,
  Receipt,
  RotateCcw,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { reportApi } from '@/api/endpoints';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

const PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'thisYear', label: 'This year' },
] as const;

// Brand-neutral categorical palette, readable in both themes.
const CHART_COLORS = ['#2563eb', '#0891b2', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#ca8a04', '#64748b'];

export function DashboardPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';

  const [preset, setPreset] = React.useState<string>('last7');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');

  const isCustom = preset === 'custom';
  const customReady = isCustom && from && to;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['dashboard', preset, from, to],
    queryFn: () =>
      reportApi.dashboard({
        preset,
        ...(customReady ? { from: new Date(from).toISOString(), to: new Date(`${to}T23:59:59`).toISOString() } : {}),
        granularity: preset === 'thisYear' ? 'month' : 'day',
      }),
    enabled: !isCustom || Boolean(customReady),
  });

  const summary = data?.summary;

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Dashboard"
        description={data ? `${data.range.label} · ${format(parseISO(data.range.from), 'dd MMM yyyy')} – ${format(parseISO(data.range.to), 'dd MMM yyyy')}` : 'Sales analytics'}
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 p-4">
          {PRESETS.map((option) => (
            <Button
              key={option.value}
              variant={preset === option.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setPreset(option.value)}
            >
              {option.label}
            </Button>
          ))}
          <Button variant={isCustom ? 'default' : 'outline'} size="sm" onClick={() => setPreset('custom')}>
            Custom range
          </Button>

          {isCustom && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs">From</Label>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">To</Label>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
              </div>
              <p className="pb-2 text-xs text-muted-foreground">Any range, across any number of years.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {isCustom && !customReady && (
        <EmptyState title="Pick a start and end date" description="Choose both dates to run the report." />
      )}

      {isLoading && <LoadingState label="Crunching the numbers…" />}
      {isError && <EmptyState title="Could not load the dashboard" description="Please try again." />}

      {data && summary && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              icon={<Banknote className="h-4 w-4" />}
              label="Net sales"
              value={formatMoney(summary.netSalesMinor, currency)}
              hint={`Gross ${formatMoney(summary.totalSalesMinor, currency)}`}
            />
            <StatTile
              icon={<Receipt className="h-4 w-4" />}
              label="Orders"
              value={String(summary.orderCount)}
              hint={`Avg ${formatMoney(summary.averageOrderValueMinor, currency)}`}
            />
            <StatTile
              icon={<Package className="h-4 w-4" />}
              label="Items sold"
              value={String(summary.itemCount)}
              hint={summary.discountMinor > 0 ? `Discounts ${formatMoney(summary.discountMinor, currency)}` : undefined}
            />
            <StatTile
              icon={<RotateCcw className="h-4 w-4" />}
              label="Returns"
              value={String(summary.returnCount)}
              hint={`${formatMoney(summary.returnAmountMinor, currency)} refunded`}
              tone={summary.returnCount > 0 ? 'warning' : undefined}
            />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4" />
                Sales trend
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.trend.length === 0 ? (
                <EmptyState title="No sales in this period" className="py-10" />
              ) : (
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="salesGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={CHART_COLORS[0]} stopOpacity={0.28} />
                          <stop offset="100%" stopColor={CHART_COLORS[0]} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="bucket"
                        tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        tickFormatter={(value: number) => formatMoneyCompact(value, currency)}
                        tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                        tickLine={false}
                        axisLine={false}
                        width={64}
                      />
                      <Tooltip
                        contentStyle={{
                          background: 'hsl(var(--popover))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        formatter={(value: number, name) =>
                          name === 'totalMinor' ? [formatMoney(value, currency), 'Sales'] : [value, name]
                        }
                      />
                      <Area
                        type="monotone"
                        dataKey="totalMinor"
                        stroke={CHART_COLORS[0]}
                        strokeWidth={2}
                        fill="url(#salesGradient)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Top products</CardTitle>
              </CardHeader>
              <CardContent>
                {data.topProducts.length === 0 ? (
                  <EmptyState title="Nothing sold yet" className="py-8" />
                ) : (
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.topProducts.slice(0, 8)} layout="vertical" margin={{ left: 8, right: 16 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
                        <YAxis
                          type="category"
                          dataKey="name"
                          width={130}
                          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip
                          contentStyle={{
                            background: 'hsl(var(--popover))',
                            border: '1px solid hsl(var(--border))',
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          formatter={(value: number) => [`${value} units`, 'Sold']}
                        />
                        <Bar dataKey="quantity" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Sales by payment method</CardTitle>
              </CardHeader>
              <CardContent>
                {data.byPaymentMethod.length === 0 ? (
                  <EmptyState title="No payments yet" className="py-8" />
                ) : (
                  <div className="flex h-64 items-center gap-4">
                    <div className="h-full flex-1">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={data.byPaymentMethod}
                            dataKey="totalMinor"
                            nameKey="method"
                            innerRadius="52%"
                            outerRadius="82%"
                            paddingAngle={2}
                          >
                            {data.byPaymentMethod.map((_, index) => (
                              <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{
                              background: 'hsl(var(--popover))',
                              border: '1px solid hsl(var(--border))',
                              borderRadius: 8,
                              fontSize: 12,
                            }}
                            formatter={(value: number) => formatMoney(value, currency)}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <ul className="w-40 space-y-1.5 text-sm">
                      {data.byPaymentMethod.map((entry, index) => (
                        <li key={entry.method} className="flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-sm"
                            style={{ background: CHART_COLORS[index % CHART_COLORS.length] }}
                          />
                          <span className="flex-1 capitalize">{entry.method}</span>
                          <span className="tabular text-xs text-muted-foreground">
                            {formatMoneyCompact(entry.totalMinor, currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <ListCard
              title="Top variants"
              rows={data.topVariants.map((variant) => ({
                key: variant.variantId,
                primary: variant.productName,
                secondary: `${variant.variantName} · ${variant.sku}`,
                value: `${variant.quantity} sold`,
                sub: formatMoney(variant.revenueMinor, currency),
              }))}
              emptyLabel="No variants sold yet"
            />
            <ListCard
              title="Sales by category"
              rows={data.byCategory.map((category) => ({
                key: String(category.categoryId ?? category.name),
                primary: category.name,
                secondary: `${category.quantity} item(s)`,
                value: formatMoney(category.revenueMinor, currency),
              }))}
              emptyLabel="No category data"
            />
            <ListCard
              title="Sales by staff"
              rows={data.byStaff.map((staff) => ({
                key: staff.cashierId,
                primary: staff.name,
                secondary: `${staff.orderCount} order(s)`,
                value: formatMoney(staff.totalMinor, currency),
              }))}
              emptyLabel="No staff sales yet"
            />
          </div>
        </>
      )}
    </div>
  );
}

function StatTile({
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
  tone?: 'warning';
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </div>
        <p className={cn('tabular mt-1 text-2xl font-semibold', tone === 'warning' && 'text-warning')}>{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function ListCard({
  title,
  rows,
  emptyLabel,
}: {
  title: string;
  rows: { key: string; primary: string; secondary?: string; value: string; sub?: string }[];
  emptyLabel: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <ul className="divide-y">
            {rows.slice(0, 8).map((row) => (
              <li key={row.key} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{row.primary}</p>
                  {row.secondary && <p className="truncate text-xs text-muted-foreground">{row.secondary}</p>}
                </div>
                <div className="shrink-0 text-right">
                  <p className="tabular text-sm font-medium">{row.value}</p>
                  {row.sub && <p className="tabular text-xs text-muted-foreground">{row.sub}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
