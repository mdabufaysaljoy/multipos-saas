import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowDownRight, ArrowDownUp, ArrowUpRight } from 'lucide-react';
import { AdvancedAnalyticsLocked } from '@/features/reports/AdvancedAnalyticsLocked';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { RangePicker, isRangeReady, rangeParams, type RangeValue } from '@/features/reports/RangePicker';
import { reportApi } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import type { BreakdownRow } from '@/types/domain';

/**
 * Advanced Analytics = detailed analysis, deliberately distinct from the
 * Dashboard. Included on Showroom and Brand; other plans see a locked screen
 * and never issue an analytics request (the API refuses them regardless).
 *
 * Every figure is computed by MongoDB aggregations over the SNAPSHOTS stored on
 * each sale line, so historical profit never shifts when a product's price or
 * cost is changed today.
 */
export function ReportsPage() {
  const { activeStore, session } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const [range, setRange] = React.useState<RangeValue>({ preset: 'last30', from: '', to: '' });
  const [branch, setBranch] = React.useState('current');
  const ready = isRangeReady(range);
  // Branch scope travels with every report query. A year reads better by month.
  const params = { ...rangeParams(range), branch, granularity: range.preset === 'thisYear' ? 'month' : 'day' };

  const isAdmin = session?.user.role === 'admin';
  const branches = session?.stores ?? [];
  const multiBranch = branches.length > 1;

  const hasAdvanced = session?.entitlement?.features?.advancedReports ?? false;

  if (!hasAdvanced) {
    return (
      <div className="space-y-5 p-4 lg:p-6">
        <PageHeader title="Advanced Analytics" description="Deeper sales, profit, product and customer analysis." />
        <AdvancedAnalyticsLocked />
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader title="Advanced Analytics" description="Deeper sales, profit, product and customer analysis." />

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <RangePicker value={range} onChange={setRange} />

            {multiBranch && (
              <div className="space-y-1">
                <Label className="text-xs">Branch</Label>
                <Select value={branch} onValueChange={setBranch}>
                  <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {isAdmin && <SelectItem value="all">All branches</SelectItem>}
                    <SelectItem value="current">Current branch</SelectItem>
                    {isAdmin &&
                      branches.map((store) => (
                        <SelectItem key={store.id} value={store.id}>
                          {store.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {!ready && <EmptyState title="Pick a start and end date" description="Choose both dates to run the report." />}

      {ready && (
        <Tabs defaultValue="sales">
          <TabsList className="h-auto flex-wrap justify-start gap-1">
            <TabsTrigger value="sales">Sales &amp; profit</TabsTrigger>
            <TabsTrigger value="products">Products</TabsTrigger>
            <TabsTrigger value="variants">Variants</TabsTrigger>
            <TabsTrigger value="categories">Categories</TabsTrigger>
            <TabsTrigger value="staff">Staff</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="returns">Returns</TabsTrigger>
            <TabsTrigger value="inventory">Inventory</TabsTrigger>
            <TabsTrigger value="customers">Customers</TabsTrigger>
            {multiBranch && isAdmin && <TabsTrigger value="branches">Branches</TabsTrigger>}
          </TabsList>

          <TabsContent value="sales"><SalesProfitTab params={params} currency={currency} /></TabsContent>
          <TabsContent value="products"><BreakdownTab dimension="product" params={params} currency={currency} title="Product performance" /></TabsContent>
          <TabsContent value="variants"><BreakdownTab dimension="variant" params={params} currency={currency} title="Variant performance" /></TabsContent>
          <TabsContent value="categories"><BreakdownTab dimension="category" params={params} currency={currency} title="Category performance" /></TabsContent>
          <TabsContent value="staff"><StaffTab params={params} currency={currency} /></TabsContent>
          <TabsContent value="payments"><PaymentsTab params={params} currency={currency} /></TabsContent>
          <TabsContent value="returns"><ReturnsTab params={params} currency={currency} /></TabsContent>
          <TabsContent value="inventory"><InventoryTab currency={currency} /></TabsContent>
          <TabsContent value="customers"><CustomersTab params={params} currency={currency} /></TabsContent>
          {multiBranch && isAdmin && (
            <TabsContent value="branches"><BranchesTab params={params} currency={currency} /></TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}

type Params = Record<string, string>;

// ------------------------------------------------------------ sales & profit

function SalesProfitTab({ params, currency }: { params: Params; currency: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['report', 'sales', params],
    queryFn: () => reportApi.sales(params),
  });

  // The session said the plan included it, but the server disagrees (the plan
  // changed since sign-in). The server is the authority.
  if (error instanceof ApiError && error.code === 'ADVANCED_ANALYTICS_REQUIRED') return <AdvancedAnalyticsLocked />;
  if (isLoading) return <LoadingState />;
  if (!data) return <EmptyState title="No data" />;

  const prev = data.previous;
  const comparison = [
    { label: 'Net sales', value: formatMoney(data.netSalesMinor, currency), now: data.netSalesMinor, before: prev.netSalesMinor },
    { label: 'Gross profit', value: formatMoney(data.netProfitMinor, currency), now: data.netProfitMinor, before: prev.netProfitMinor },
    { label: 'Orders', value: String(data.invoiceCount), now: data.invoiceCount, before: prev.invoiceCount },
    { label: 'Items sold', value: String(data.itemCount), now: data.itemCount, before: prev.itemCount },
    { label: 'Average order', value: formatMoney(data.averageOrderValueMinor, currency), now: data.averageOrderValueMinor, before: prev.averageOrderValueMinor },
    { label: 'Discounts', value: formatMoney(data.discountsMinor, currency), now: data.discountsMinor, before: prev.discountsMinor, lowerIsBetter: true },
    { label: 'Returns', value: formatMoney(data.returnAmountMinor, currency), now: data.returnAmountMinor, before: prev.returnAmountMinor, lowerIsBetter: true },
    { label: 'Margin', value: `${(data.marginBasisPoints / 100).toFixed(1)}%`, now: data.marginBasisPoints, before: prev.marginBasisPoints },
  ];
  const returnShare = data.grossSalesMinor > 0 ? (data.returnAmountMinor / data.grossSalesMinor) * 100 : 0;

  /** The P&L waterfall, in the order the business reads it. */
  const lines = [
    { label: 'Gross sales', value: data.grossSalesMinor, tone: '' },
    { label: 'Discounts', value: -data.discountsMinor, tone: 'text-warning' },
    { label: 'Returns', value: -data.returnAmountMinor, tone: 'text-destructive' },
    { label: 'Net sales', value: data.netSalesMinor, tone: 'font-semibold border-t pt-2' },
    { label: 'Cost of goods sold', value: -data.cogsMinor, tone: 'text-muted-foreground' },
    { label: 'Net profit', value: data.netProfitMinor, tone: 'text-lg font-bold border-t pt-2 text-success' },
  ];

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs text-muted-foreground">
          Compared with the previous period: {format(parseISO(prev.range.from), 'dd MMM yyyy')} –{' '}
          {format(parseISO(prev.range.to), 'dd MMM yyyy')}
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {comparison.map((item) => (
            <Card key={item.label}>
              <CardContent className="p-4">
                <Stat label={item.label} value={item.value} />
                <Delta now={item.now} before={item.before} lowerIsBetter={item.lowerIsBetter} />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Card>
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
                    <linearGradient id="analyticsGradient" x1="0" y1="0" x2="0" y2="1">
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
                  <Area type="monotone" dataKey="totalMinor" stroke="#2563eb" strokeWidth={2} fill="url(#analyticsGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Profit &amp; loss</CardTitle>
          <CardDescription>
            {format(parseISO(data.range.from), 'dd MMM yyyy')} – {format(parseISO(data.range.to), 'dd MMM yyyy')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            {lines.map((line) => (
              <div key={line.label} className={cn('flex justify-between', line.tone)}>
                <dt>{line.label}</dt>
                <dd className="tabular">{formatMoney(line.value, currency)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Profit uses the cost captured on each sale line at the time of sale, never the product's current cost.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Return impact</CardTitle>
          <CardDescription>How much of the period's gross sales came back.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <Stat label="Returns" value={String(data.returnCount)} />
          <Stat label="Items returned" value={String(data.returnedItems)} />
          <Stat label="Refunded" value={formatMoney(data.returnAmountMinor, currency)} />
          <Stat label="Share of gross sales" value={`${returnShare.toFixed(1)}%`} />
          <Stat label="Cost of goods sold" value={formatMoney(data.cogsMinor, currency)} />
          <Stat label="Tax collected" value={formatMoney(data.taxMinor, currency)} />
        </CardContent>
      </Card>
    </div>
    </div>
  );
}

/** Change against the previous period, coloured by whether it is good news. */
function Delta({ now, before, lowerIsBetter }: { now: number; before: number; lowerIsBetter?: boolean }) {
  if (before === 0) {
    return <p className="mt-1 text-xs text-muted-foreground">{now === 0 ? 'No change' : 'No sales in the previous period'}</p>;
  }
  const change = ((now - before) / Math.abs(before)) * 100;
  if (Math.abs(change) < 0.05) return <p className="mt-1 text-xs text-muted-foreground">No change</p>;
  const up = change > 0;
  const good = lowerIsBetter ? !up : up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <p className={cn('mt-1 flex items-center gap-0.5 text-xs font-medium', good ? 'text-success' : 'text-destructive')}>
      <Icon className="h-3.5 w-3.5" />
      {Math.abs(change).toFixed(1)}% vs previous
    </p>
  );
}

// ---------------------------------------------------------------- breakdowns

function BreakdownTab({
  dimension,
  params,
  currency,
  title,
}: {
  dimension: string;
  params: Params;
  currency: string;
  title: string;
}) {
  const [sortBy, setSortBy] = React.useState('quantity');
  const [order, setOrder] = React.useState<'asc' | 'desc'>('desc');

  const { data, isLoading } = useQuery({
    queryKey: ['report', 'breakdown', dimension, params, sortBy, order],
    queryFn: () => reportApi.breakdown({ ...params, dimension, sortBy, order, limit: 25 }),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>
              Quantities and revenue are net of returns. Sort ascending to find slow movers.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="quantity">Quantity</SelectItem>
                <SelectItem value="revenue">Revenue</SelectItem>
                <SelectItem value="profit">Profit</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" onClick={() => setOrder((o) => (o === 'desc' ? 'asc' : 'desc'))} title={order === 'desc' ? 'Highest first' : 'Lowest first'}>
              <ArrowDownUp />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <LoadingState />
        ) : (data?.rows.length ?? 0) === 0 ? (
          <EmptyState title="Nothing sold in this period" />
        ) : (
          <BreakdownTable rows={data!.rows} currency={currency} />
        )}
      </CardContent>
    </Card>
  );
}

function BreakdownTable({ rows, currency }: { rows: BreakdownRow[]; currency: string }) {
  return (
    <div className="scrollbar-thin overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2 text-left font-semibold">Item</th>
            <th className="px-4 py-2 text-right font-semibold">Sold</th>
            <th className="px-4 py-2 text-right font-semibold">Returned</th>
            <th className="px-4 py-2 text-right font-semibold">Revenue</th>
            <th className="px-4 py-2 text-right font-semibold">Cost</th>
            <th className="px-4 py-2 text-right font-semibold">Profit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.id ?? row.label}-${index}`} className="border-b last:border-0">
              <td className="px-4 py-2">
                <p className="font-medium">{row.label || 'Unspecified'}</p>
                {(row.sub || row.sku) && (
                  <p className="text-xs text-muted-foreground">
                    {row.sub}
                    {row.sub && row.sku ? ' · ' : ''}
                    {row.sku && <span className="font-mono">{row.sku}</span>}
                  </p>
                )}
              </td>
              <td className="tabular px-4 py-2 text-right">{row.quantity}</td>
              <td className="tabular px-4 py-2 text-right">
                {row.returnedQuantity > 0 ? <span className="text-destructive">{row.returnedQuantity}</span> : '—'}
              </td>
              <td className="tabular px-4 py-2 text-right">{formatMoney(row.revenueMinor, currency)}</td>
              <td className="tabular px-4 py-2 text-right text-muted-foreground">{formatMoney(row.costMinor, currency)}</td>
              <td className={cn('tabular px-4 py-2 text-right font-medium', row.profitMinor >= 0 ? 'text-success' : 'text-destructive')}>
                {formatMoney(row.profitMinor, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// -------------------------------------------------------------------- others

function StaffTab({ params, currency }: { params: Params; currency: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['report', 'staff', params], queryFn: () => reportApi.staff(params) });
  if (isLoading) return <LoadingState />;
  if (!data?.rows.length) return <EmptyState title="No staff sales in this period" />;

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">Staff performance</CardTitle></CardHeader>
      <CardContent className="p-0">
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 text-left font-semibold">Staff</th>
                <th className="px-4 py-2 text-right font-semibold">Orders</th>
                <th className="px-4 py-2 text-right font-semibold">Items</th>
                <th className="px-4 py-2 text-right font-semibold">Revenue</th>
                <th className="px-4 py-2 text-right font-semibold">Profit</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{row.label}</td>
                  <td className="tabular px-4 py-2 text-right">{row.orderCount}</td>
                  <td className="tabular px-4 py-2 text-right">{row.itemCount}</td>
                  <td className="tabular px-4 py-2 text-right">{formatMoney(row.revenueMinor, currency)}</td>
                  <td className="tabular px-4 py-2 text-right font-medium text-success">{formatMoney(row.profitMinor, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function PaymentsTab({ params, currency }: { params: Params; currency: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['report', 'payments', params], queryFn: () => reportApi.payments(params) });
  if (isLoading) return <LoadingState />;
  if (!data?.rows.length) return <EmptyState title="No payments in this period" />;

  const total = data.rows.reduce((sum, row) => sum + row.amountMinor, 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Payments by method</CardTitle>
        <CardDescription>Split payments are counted per tender, so this reconciles to the drawer.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {data.rows.map((row) => {
            const share = total > 0 ? Math.round((row.amountMinor / total) * 100) : 0;
            return (
              <li key={row.method} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium capitalize">{row.method}</span>
                  <span className="tabular">
                    {formatMoney(row.amountMinor, currency)}
                    <span className="ml-2 text-xs text-muted-foreground">{share}%</span>
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex justify-between border-t pt-2 font-semibold">
          <span>Total collected</span>
          <span className="tabular">{formatMoney(total, currency)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function ReturnsTab({ params, currency }: { params: Params; currency: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['report', 'returns', params], queryFn: () => reportApi.returns(params) });
  if (isLoading) return <LoadingState />;
  if (!data) return <EmptyState title="No data" />;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4"><Stat label="Returns" value={String(data.summary.count)} /></CardContent></Card>
        <Card><CardContent className="p-4"><Stat label="Items returned" value={String(data.summary.items)} /></CardContent></Card>
        <Card><CardContent className="p-4"><Stat label="Refunded" value={formatMoney(data.summary.amountMinor, currency)} /></CardContent></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Most returned</CardTitle></CardHeader>
          <CardContent>
            {data.byProduct.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No returns in this period</p>
            ) : (
              <ul className="divide-y">
                {data.byProduct.map((row) => (
                  <li key={row.id} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{row.label}</p>
                      <p className="truncate text-xs text-muted-foreground">{row.sub} · <span className="font-mono">{row.sku}</span></p>
                    </div>
                    <Badge variant="destructive">{row.quantity}</Badge>
                    <span className="tabular text-sm">{formatMoney(row.amountMinor, currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Reasons</CardTitle></CardHeader>
          <CardContent>
            {data.byReason.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Nothing to show</p>
            ) : (
              <ul className="divide-y">
                {data.byReason.map((row) => (
                  <li key={row.reason} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
                    <span className="min-w-0 flex-1 truncate text-sm">{row.reason}</span>
                    <Badge variant="secondary">{row.count}</Badge>
                    <span className="tabular text-sm">{formatMoney(row.amountMinor, currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function InventoryTab({ currency }: { currency: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['report', 'inventory'], queryFn: () => reportApi.inventory({ limit: 15 }) });
  if (isLoading) return <LoadingState />;
  if (!data) return <EmptyState title="No data" />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card><CardContent className="p-4"><Stat label="Units on hand" value={String(data.summary.units)} /></CardContent></Card>
        <Card><CardContent className="p-4"><Stat label="Stock value (cost)" value={formatMoney(data.summary.costValueMinor, currency)} /></CardContent></Card>
        <Card><CardContent className="p-4"><Stat label="Retail value" value={formatMoney(data.summary.retailValueMinor, currency)} /></CardContent></Card>
        <Card><CardContent className="p-4"><Stat label="Out of stock" value={String(data.summary.outOfStockCount)} /></CardContent></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SimpleList
          title="Running low"
          rows={data.lowStock.map((r) => ({ key: r._id, primary: r.productNameSnapshot, secondary: `${r.name} · ${r.sku}`, value: `${r.stock} left` }))}
          empty="Stock levels look healthy"
        />
        <SimpleList
          title="Highest stock value"
          rows={data.topValue.map((r) => ({ key: r._id, primary: r.productNameSnapshot, secondary: `${r.name} · ${r.stock} units`, value: formatMoney(r.valueMinor, currency) }))}
          empty="No stock recorded"
        />
      </div>
    </div>
  );
}

function CustomersTab({ params, currency }: { params: Params; currency: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['report', 'customers', params],
    queryFn: () => reportApi.customers(params),
  });

  if (isLoading) return <LoadingState />;
  if (!data) return <EmptyState title="No data" />;

  const { summary } = data;
  const repeatRate = summary.customers > 0 ? (summary.repeatCustomers / summary.customers) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card><CardContent className="p-4"><Stat label="Buying customers" value={String(summary.customers)} /></CardContent></Card>
        <Card><CardContent className="p-4"><Stat label="Repeat customers" value={`${summary.repeatCustomers} (${repeatRate.toFixed(0)}%)`} /></CardContent></Card>
        <Card><CardContent className="p-4"><Stat label="Customer sales" value={formatMoney(summary.totalMinor, currency)} /></CardContent></Card>
        <Card><CardContent className="p-4"><Stat label="Avg spend per customer" value={formatMoney(summary.averageSpendMinor, currency)} /></CardContent></Card>
      </div>

      <Card>
        <CardContent className="flex items-center justify-between p-4 text-sm">
          <span className="text-muted-foreground">Walk-in sales (no customer recorded)</span>
          <span className="tabular font-medium">
            {data.walkIn.count} · {formatMoney(data.walkIn.totalMinor, currency)}
          </span>
        </CardContent>
      </Card>

      <SimpleList
        title="Top customers"
        rows={data.rows.map((r) => ({
          key: r.id,
          primary: r.label,
          secondary: `${r.sub} · ${r.orderCount} order${r.orderCount === 1 ? '' : 's'}`,
          value: formatMoney(r.spentMinor, currency),
        }))}
        empty="No customer sales in this period"
      />
    </div>
  );
}

function BranchesTab({ params, currency }: { params: Params; currency: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['report', 'branches', params],
    queryFn: () => reportApi.branches(params),
  });

  if (isLoading) return <LoadingState />;
  if (!data?.rows.length) return <EmptyState title="No branches to compare" />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card><CardContent className="p-4"><Stat label="Orders (all branches)" value={String(data.totals.orders)} /></CardContent></Card>
        <Card><CardContent className="p-4"><Stat label="Net sales" value={formatMoney(data.totals.netSalesMinor, currency)} /></CardContent></Card>
        <Card><CardContent className="p-4"><Stat label="Profit" value={formatMoney(data.totals.profitMinor, currency)} /></CardContent></Card>
        <Card><CardContent className="p-4"><Stat label="Stock value" value={formatMoney(data.totals.stockValueMinor, currency)} /></CardContent></Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Branch comparison</CardTitle>
          <CardDescription>Each branch keeps its own stock, staff and sales; these are the aggregated figures.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 text-left font-semibold">Branch</th>
                  <th className="px-4 py-2 text-right font-semibold">Orders</th>
                  <th className="px-4 py-2 text-right font-semibold">Net sales</th>
                  <th className="px-4 py-2 text-right font-semibold">Returns</th>
                  <th className="px-4 py-2 text-right font-semibold">Profit</th>
                  <th className="px-4 py-2 text-right font-semibold">Stock value</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      <p className="font-medium">{row.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">{row.code}</p>
                    </td>
                    <td className="tabular px-4 py-2 text-right">{row.orders}</td>
                    <td className="tabular px-4 py-2 text-right">{formatMoney(row.netSalesMinor, currency)}</td>
                    <td className="tabular px-4 py-2 text-right">
                      {row.returnCount > 0 ? <span className="text-destructive">{formatMoney(row.returnAmountMinor, currency)}</span> : '—'}
                    </td>
                    <td className={cn('tabular px-4 py-2 text-right font-medium', row.profitMinor >= 0 ? 'text-success' : 'text-destructive')}>
                      {formatMoney(row.profitMinor, currency)}
                    </td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">
                      {formatMoney(row.stockValueMinor, currency)}
                      <span className="ml-1 text-xs">({row.stockUnits}u)</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------- shared

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="tabular mt-0.5 text-xl font-semibold">{value}</p>
    </div>
  );
}

function SimpleList({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: { key: string; primary: string; secondary?: string; value: string }[];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y">
            {rows.map((row) => (
              <li key={row.key} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{row.primary}</p>
                  {row.secondary && <p className="truncate text-xs text-muted-foreground">{row.secondary}</p>}
                </div>
                <span className="tabular shrink-0 text-sm font-medium">{row.value}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
