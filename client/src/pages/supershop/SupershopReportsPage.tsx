import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { AdvancedAnalyticsLocked } from '@/features/reports/AdvancedAnalyticsLocked';
import { PrintReportButton } from '@/features/reports/PrintReportButton';
import { REPORT_PRESETS, RangePicker, isRangeReady, rangeParams, type RangeValue } from '@/features/reports/RangePicker';
import { ApiError } from '@/api/client';
import { supershopApi } from '@/api/supershop';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { formatQuantity, formatVatRate } from '@/lib/supershop';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import type { ShopReports } from '@/types/supershop';

const isLocked = (error: unknown) => error instanceof ApiError && error.code === 'ADVANCED_ANALYTICS_REQUIRED';
const bps = (value: number) => `${(value / 100).toFixed(1)}%`;

/**
 * Super Shop Advanced Analytics.
 *
 * Laid out like Clothing's - a filter card, tabs, a row of compared headline
 * figures, then the detail - so an owner who runs both reads them the same way.
 * The METRICS are Super Shop's own: departments and brands rather than
 * categories and variants, weighed goods counted apart from pieces, and VAT
 * taken out before profit because a Super Shop price includes it.
 *
 * One request feeds every tab. The server does the aggregation and applies the
 * branch rules; nothing here counts a sale.
 */
export function SupershopReportsPage() {
  const { session, activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const money = (minor: number) => formatMoney(minor, currency);
  const hasAdvanced = session?.entitlement?.features?.advancedReports ?? false;
  const isAdmin = session?.user.role === 'admin';

  const [range, setRange] = React.useState<RangeValue>({ preset: 'last30', from: '', to: '' });
  const ready = isRangeReady(range);
  // A date range and the tabs. The report endpoint still accepts narrowing
  // filters - staff, department, brand, product, tender, customer - and they
  // are still covered by tests; this screen simply does not put a row of
  // dropdowns in front of them, because the tabs already answer the same
  // questions with less to read.
  const params = rangeParams(range);

  const { data, isLoading, error } = useQuery({
    queryKey: ['supershop', 'reports', range],
    queryFn: () => supershopApi.reports(params),
    enabled: hasAdvanced && ready,
    retry: false,
  });

  if (!hasAdvanced || isLocked(error)) {
    return (
      <div className="space-y-5 p-4 lg:p-6">
        <PageHeader title="Advanced Analytics" description="Deeper sales, profit, product and customer analysis." />
        <AdvancedAnalyticsLocked />
      </div>
    );
  }

  const multiBranch = (data?.branches ?? []).length > 1;

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Advanced Analytics"
        description="Deeper sales, profit, product and customer analysis."
        actions={<PrintReportButton path="/supershop/reports/print" params={params} disabled={!data} />}
      />

      <Card>
        <CardContent className="p-4">
          <RangePicker value={range} onChange={setRange} presets={REPORT_PRESETS} />
        </CardContent>
      </Card>

      {!ready && <EmptyState title="Pick a start and end date" description="Choose both dates to run the report." />}
      {ready && isLoading && <LoadingState label="Crunching the numbers…" />}
      {ready && error && !isLocked(error) && <EmptyState title="Could not load the reports" description="Please try again." />}

      {ready && data && (
        <>
          <Tabs defaultValue="sales">
            <TabsList className="h-auto flex-wrap justify-start gap-1">
              <TabsTrigger value="sales">Sales &amp; profit</TabsTrigger>
              <TabsTrigger value="products">Products</TabsTrigger>
              <TabsTrigger value="departments">Departments</TabsTrigger>
              <TabsTrigger value="brands">Brands</TabsTrigger>
              <TabsTrigger value="staff">Staff</TabsTrigger>
              <TabsTrigger value="payments">Payments</TabsTrigger>
              <TabsTrigger value="vat">VAT</TabsTrigger>
              <TabsTrigger value="returns">Returns</TabsTrigger>
              <TabsTrigger value="inventory">Inventory</TabsTrigger>
              <TabsTrigger value="customers">Customers</TabsTrigger>
              {multiBranch && isAdmin && <TabsTrigger value="branches">Branches</TabsTrigger>}
            </TabsList>

            <TabsContent value="sales">
              <SalesProfitTab data={data} currency={currency} money={money} />
            </TabsContent>
            <TabsContent value="products">
              <ProductsTab data={data} money={money} />
            </TabsContent>
            <TabsContent value="departments">
              <DepartmentsTab data={data} money={money} />
            </TabsContent>
            <TabsContent value="brands">
              <BrandsTab data={data} money={money} />
            </TabsContent>
            <TabsContent value="staff">
              <StaffTab data={data} money={money} />
            </TabsContent>
            <TabsContent value="payments">
              <PaymentsTab data={data} money={money} />
            </TabsContent>
            <TabsContent value="vat">
              <VatTab data={data} money={money} />
            </TabsContent>
            <TabsContent value="returns">
              <ReturnsTab data={data} money={money} />
            </TabsContent>
            <TabsContent value="inventory">
              <InventoryTab data={data} money={money} />
            </TabsContent>
            <TabsContent value="customers">
              <CustomersTab data={data} money={money} />
            </TabsContent>
            {multiBranch && isAdmin && (
              <TabsContent value="branches">
                <BranchesTab data={data} money={money} />
              </TabsContent>
            )}
          </Tabs>
        </>
      )}
    </div>
  );
}

type Money = (minor: number) => string;

// ------------------------------------------------------------ sales & profit

function SalesProfitTab({ data, currency, money }: { data: ShopReports; currency: string; money: Money }) {
  const t = data.totals;
  const p = data.previous;
  const headline = [
    { label: 'Net sales', value: money(t.netSalesMinor), now: t.netSalesMinor, before: p.netSalesMinor },
    { label: 'Gross profit', value: money(t.grossProfitMinor), now: t.grossProfitMinor, before: p.grossProfitMinor },
    { label: 'Sales', value: String(t.salesCount), now: t.salesCount, before: p.salesCount },
    { label: 'Pieces sold', value: String(t.unitsSold), now: t.unitsSold, before: p.unitsSold },
    { label: 'Average basket', value: money(t.averageBasketMinor), now: t.averageBasketMinor, before: p.averageBasketMinor },
    { label: 'Discounts', value: money(t.discountsMinor), now: t.discountsMinor, before: p.discountsMinor, lowerIsBetter: true },
    { label: 'Refunds', value: money(t.returnAmountMinor), now: t.returnAmountMinor, before: p.returnAmountMinor, lowerIsBetter: true },
    { label: 'Margin', value: bps(t.marginBps), now: t.marginBps, before: p.marginBps },
  ];

  // The P&L, in the order a shopkeeper reads it. VAT comes out before profit
  // because a Super Shop price includes it: it was collected, not earned.
  const lines = [
    { label: 'Gross sales', value: t.grossSalesMinor, tone: '' },
    { label: 'Discounts', value: -t.discountsMinor, tone: 'text-warning' },
    { label: 'Refunds', value: -t.returnAmountMinor, tone: 'text-destructive' },
    { label: 'Net sales', value: t.netSalesMinor, tone: 'border-t pt-2 font-semibold' },
    { label: 'VAT collected (included in the price)', value: -t.vatMinor, tone: 'text-muted-foreground' },
    { label: 'Cost of goods sold', value: -t.costMinor, tone: 'text-muted-foreground' },
    { label: 'Gross profit', value: t.grossProfitMinor, tone: 'border-t pt-2 text-lg font-bold text-success' },
  ];

  const returnShare = t.grossSalesMinor > 0 ? (t.returnAmountMinor / t.grossSalesMinor) * 100 : 0;

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs text-muted-foreground">Compared with the period immediately before this one.</p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {headline.map((item) => (
            <Card key={item.label}>
              <CardContent className="p-4">
                <Stat label={item.label} value={item.value} />
                <Delta now={item.now} before={item.before} lowerIsBetter={item.lowerIsBetter} />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {data.selection && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">The lines you filtered to</CardTitle>
            <CardDescription>
              A department, brand or product filter picks LINES. The figures above are still whole baskets.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Lines" value={`${data.selection.lines} in ${data.selection.salesCount} sale(s)`} />
            <Stat label="Revenue" value={money(data.selection.revenueMinor)} />
            <Stat label="Cost" value={money(data.selection.costMinor)} />
            <Stat label="Profit" value={`${money(data.selection.profitMinor)} · ${bps(data.selection.marginBps)}`} />
          </CardContent>
        </Card>
      )}

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
                    <linearGradient id="shopAnalyticsGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#2563eb" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="#2563eb" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
                  <YAxis
                    tickFormatter={(v: number) => formatMoneyCompact(v, currency)}
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    tickLine={false}
                    axisLine={false}
                    width={60}
                  />
                  <Tooltip
                    contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
                    formatter={(v: number) => [money(v), 'Net sales']}
                  />
                  <Area type="monotone" dataKey="netSalesMinor" stroke="#2563eb" strokeWidth={2} fill="url(#shopAnalyticsGradient)" />
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
                <div key={line.label} className={cn('flex justify-between gap-3', line.tone)}>
                  <dt>{line.label}</dt>
                  <dd className="tabular shrink-0">{money(line.value)}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              Profit uses the weighted average cost captured on each sale line at the time of sale, never the product's cost today.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Return impact</CardTitle>
            <CardDescription>How much of the period's gross sales came back.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <Stat label="Refunds" value={String(data.returns.count)} />
            <Stat label="Refunded" value={money(data.returns.amountMinor)} />
            <Stat label="Share of gross sales" value={`${returnShare.toFixed(1)}%`} />
            <Stat label="Cost of goods returned" value={money(data.returns.costMinor)} />
            <Stat label="VAT collected" value={money(t.vatMinor)} />
            <Stat label="Average lines per sale" value={String(t.averageLines)} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** Change against the previous period, coloured by whether it is good news. */
function Delta({ now, before, lowerIsBetter }: { now: number; before: number; lowerIsBetter?: boolean }) {
  if (before === 0) {
    return <p className="mt-1 text-xs text-muted-foreground">{now === 0 ? 'No change' : 'Nothing in the previous period'}</p>;
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

/** One table, however the rows were grouped. */
function RowTable({
  columns,
  rows,
  empty,
}: {
  columns: { key: string; label: string; align?: 'right' }[];
  rows: Record<string, React.ReactNode>[];
  empty: string;
}) {
  if (rows.length === 0) return <EmptyState title={empty} className="py-10" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={cn('pb-2 text-left font-medium', column.align === 'right' && 'text-right')}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t">
              {columns.map((column) => (
                <td key={column.key} className={cn('py-1.5', column.align === 'right' && 'tabular text-right')}>
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------- the tabs

function ProductsTab({ data, money }: { data: ShopReports; money: Money }) {
  return (
    <Panel title="Product performance" description="Per line, before any sale-level discount.">
      <RowTable
        empty="Nothing sold in this period"
        columns={[
          { key: 'name', label: 'Product' },
          { key: 'quantity', label: 'Sold', align: 'right' },
          { key: 'revenue', label: 'Revenue', align: 'right' },
          { key: 'cost', label: 'Cost', align: 'right' },
          { key: 'profit', label: 'Profit', align: 'right' },
          { key: 'margin', label: 'Margin', align: 'right' },
        ]}
        rows={data.products.map((row) => ({
          name: row.name,
          quantity: formatQuantity(row.quantity, row.unitType),
          revenue: money(row.revenueMinor),
          cost: money(row.costMinor),
          profit: money(row.profitMinor),
          margin: bps(row.marginBps),
        }))}
      />
    </Panel>
  );
}

function DepartmentsTab({ data, money }: { data: ShopReports; money: Money }) {
  return (
    <Panel title="Department performance" description="Which aisles earn their shelf space.">
      <RowTable
        empty="No sales in this period"
        columns={[
          { key: 'name', label: 'Department' },
          { key: 'lines', label: 'Lines', align: 'right' },
          { key: 'revenue', label: 'Revenue', align: 'right' },
          { key: 'profit', label: 'Profit', align: 'right' },
        ]}
        rows={data.departments.map((row) => ({
          name: row.department,
          lines: row.lines,
          revenue: money(row.revenueMinor),
          profit: money(row.profitMinor),
        }))}
      />
    </Panel>
  );
}

function BrandsTab({ data, money }: { data: ShopReports; money: Money }) {
  return (
    <Panel title="Brand performance" description="Unbranded goods are not a brand, and are left out.">
      <RowTable
        empty="Nothing branded sold in this period"
        columns={[
          { key: 'name', label: 'Brand' },
          { key: 'lines', label: 'Lines', align: 'right' },
          { key: 'revenue', label: 'Revenue', align: 'right' },
          { key: 'cost', label: 'Cost', align: 'right' },
          { key: 'profit', label: 'Profit', align: 'right' },
          { key: 'margin', label: 'Margin', align: 'right' },
        ]}
        rows={data.brands.map((row) => ({
          name: row.brand,
          lines: row.lines,
          revenue: money(row.revenueMinor),
          cost: money(row.costMinor),
          profit: money(row.profitMinor),
          margin: bps(row.marginBps),
        }))}
      />
    </Panel>
  );
}

function StaffTab({ data, money }: { data: ShopReports; money: Money }) {
  return (
    <div className="space-y-4">
      <Panel title="Sales by staff" description="Whole baskets: a sale belongs to whoever rang it up.">
        <RowTable
          empty="Nobody sold anything in this period"
          columns={[
            { key: 'name', label: 'Cashier' },
            { key: 'sales', label: 'Sales', align: 'right' },
            { key: 'net', label: 'Net sales', align: 'right' },
            { key: 'basket', label: 'Basket', align: 'right' },
            { key: 'discounts', label: 'Discounts', align: 'right' },
            { key: 'profit', label: 'Profit', align: 'right' },
            { key: 'margin', label: 'Margin', align: 'right' },
          ]}
          rows={data.staff.map((row) => ({
            name: row.name,
            sales: row.salesCount,
            net: money(row.netSalesMinor),
            basket: money(row.averageBasketMinor),
            discounts: money(row.discountsMinor),
            profit: money(row.profitMinor),
            margin: bps(row.marginBps),
          }))}
        />
      </Panel>
      <Panel title="Discounts given" description="Who is taking money off, and how much.">
        <RowTable
          empty="No discounts in this period"
          columns={[
            { key: 'name', label: 'Cashier' },
            { key: 'sales', label: 'Sales', align: 'right' },
            { key: 'discounts', label: 'Discounts', align: 'right' },
          ]}
          rows={data.discounts.byStaff.map((row) => ({
            name: row.name,
            sales: row.sales,
            discounts: money(row.discountsMinor),
          }))}
        />
      </Panel>
    </div>
  );
}

function PaymentsTab({ data, money }: { data: ShopReports; money: Money }) {
  return (
    <div className="space-y-4">
      <Panel title="Payments taken" description="Cash is net of the change given back.">
        <RowTable
          empty="Nothing was taken in this period"
          columns={[
            { key: 'method', label: 'Method' },
            { key: 'sales', label: 'Sales', align: 'right' },
            { key: 'amount', label: 'Taken', align: 'right' },
          ]}
          rows={data.payments.map((row) => ({ method: row.method, sales: row.sales, amount: money(row.amountMinor) }))}
        />
      </Panel>
      <Panel title="Busy hours" description="When the till is working hardest.">
        <RowTable
          empty="No sales in this period"
          columns={[
            { key: 'hour', label: 'Hour' },
            { key: 'sales', label: 'Sales', align: 'right' },
            { key: 'net', label: 'Net sales', align: 'right' },
          ]}
          rows={data.hours.map((row) => ({ hour: `${row.hour}:00`, sales: row.salesCount, net: money(row.netSalesMinor) }))}
        />
      </Panel>
    </div>
  );
}

function VatTab({ data, money }: { data: ShopReports; money: Money }) {
  const t = data.totals;
  const netOfVat = t.netSalesMinor - t.vatMinor;
  const effective = netOfVat > 0 ? (t.vatMinor / netOfVat) * 100 : 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">VAT collected</CardTitle>
          <CardDescription>
            Super Shop prices INCLUDE VAT, so this is what sat inside what was charged — never an amount added on top of it. It is
            collected for the government, which is why it comes out before profit.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Net sales (incl. VAT)" value={money(t.netSalesMinor)} />
          <Stat label="Excluding VAT" value={money(netOfVat)} />
          <Stat label="VAT collected" value={money(t.vatMinor)} />
          <Stat label="Effective rate" value={`${effective.toFixed(2)}%`} />
        </CardContent>
      </Card>

      <Panel title="By rate" description="Every rate the period's lines carried, and what each one raised.">
        <RowTable
          empty="No sales in this period"
          columns={[
            { key: 'rate', label: 'Rate' },
            { key: 'lines', label: 'Lines', align: 'right' },
            { key: 'gross', label: 'Charged', align: 'right' },
            { key: 'net', label: 'Excl. VAT', align: 'right' },
            { key: 'vat', label: 'VAT', align: 'right' },
          ]}
          rows={data.vatRates.map((row) => ({
            rate: formatVatRate(row.vatRateBps),
            lines: row.lines,
            gross: money(row.grossMinor),
            net: money(row.netOfVatMinor),
            vat: money(row.vatMinor),
          }))}
        />
      </Panel>

      <p className="text-xs text-muted-foreground">
        A refund gives back the VAT that was collected with it. These figures are for sales that stand; what came back is on the
        Returns tab.
      </p>
    </div>
  );
}

function ReturnsTab({ data, money }: { data: ShopReports; money: Money }) {
  return (
    <div className="space-y-4">
      <Panel title="Refunds" description="A refund gives money back on a sale that stands.">
        <RowTable
          empty="Nothing came back in this period"
          columns={[
            { key: 'number', label: 'Refund' },
            { key: 'sale', label: 'Sale' },
            { key: 'reason', label: 'Reason' },
            { key: 'by', label: 'Taken by' },
            { key: 'amount', label: 'Refunded', align: 'right' },
          ]}
          rows={data.returns.recent.map((row) => ({
            number: row.returnNumber,
            sale: row.saleNumber,
            reason: row.reason,
            by: row.by,
            amount: money(row.totalMinor),
          }))}
        />
      </Panel>
      <Panel title="Voided sales" description="A void cancels a sale outright; it is not a refund.">
        <RowTable
          empty="Nothing was voided in this period"
          columns={[
            { key: 'sale', label: 'Sale' },
            { key: 'reason', label: 'Reason' },
            { key: 'by', label: 'Voided by' },
            { key: 'amount', label: 'Value', align: 'right' },
          ]}
          rows={data.voids.recent.map((row) => ({
            sale: row.saleNumber,
            reason: row.voidReason,
            by: row.voidedByNameSnapshot,
            amount: money(row.totalMinor),
          }))}
        />
      </Panel>
    </div>
  );
}

function InventoryTab({ data, money }: { data: ShopReports; money: Money }) {
  return (
    <div className="space-y-4">
      <Panel title="Write-offs" description="Valued at what the goods cost, not what they would have sold for.">
        <RowTable
          empty="Nothing was written off in this period"
          columns={[
            { key: 'name', label: 'Product' },
            { key: 'quantity', label: 'Quantity', align: 'right' },
            { key: 'cost', label: 'Cost', align: 'right' },
          ]}
          rows={data.writeOffs.byProduct.map((row) => ({
            name: row.name,
            quantity: formatQuantity(row.quantity, row.unitType),
            cost: money(row.costMinor),
          }))}
        />
      </Panel>
      <Panel title="Dead stock" description="On the shelf, but not sold once in this period.">
        <RowTable
          empty="Everything in stock sold at least once"
          columns={[
            { key: 'name', label: 'Product' },
            { key: 'onHand', label: 'On hand', align: 'right' },
            { key: 'value', label: 'At cost', align: 'right' },
          ]}
          rows={data.deadStock.map((row) => ({
            name: row.name,
            onHand: formatQuantity(row.quantityOnHand, row.unitType),
            value: money(row.stockCostMinor),
          }))}
        />
      </Panel>
    </div>
  );
}

function CustomersTab({ data, money }: { data: ShopReports; money: Money }) {
  return (
    <Panel title="Top customers" description="Walk-in sales carry no customer and are not counted here.">
      <RowTable
        empty="Every sale this period was a walk-in"
        columns={[
          { key: 'name', label: 'Customer' },
          { key: 'sales', label: 'Sales', align: 'right' },
          { key: 'net', label: 'Net sales', align: 'right' },
          { key: 'basket', label: 'Basket', align: 'right' },
        ]}
        rows={data.customers.map((row) => ({
          name: row.name,
          sales: row.salesCount,
          net: money(row.netSalesMinor),
          basket: money(row.averageBasketMinor),
        }))}
      />
    </Panel>
  );
}

function BranchesTab({ data, money }: { data: ShopReports; money: Money }) {
  return (
    <Panel title="Branch comparison" description="Only the branches this report was run across.">
      <RowTable
        empty="No sales in this period"
        columns={[
          { key: 'name', label: 'Branch' },
          { key: 'sales', label: 'Sales', align: 'right' },
          { key: 'net', label: 'Net sales', align: 'right' },
          { key: 'cost', label: 'Cost', align: 'right' },
          { key: 'profit', label: 'Profit', align: 'right' },
          { key: 'margin', label: 'Margin', align: 'right' },
        ]}
        rows={data.branchBreakdown.map((row) => ({
          name: row.name,
          sales: row.salesCount,
          net: money(row.netSalesMinor),
          cost: money(row.costMinor),
          profit: money(row.profitMinor),
          margin: bps(row.marginBps),
        }))}
      />
    </Panel>
  );
}
