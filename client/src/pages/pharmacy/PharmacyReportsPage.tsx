import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { Ban, CalendarClock, CreditCard, Package, Percent, Pill, TrendingUp, Trash2, Turtle, Users } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { AdvancedAnalyticsLocked } from '@/features/reports/AdvancedAnalyticsLocked';
import { ReturnsCardBody, ReturnsCardIcon } from '@/features/reports/ReturnsCard';
import { AnalyticsCard, AnalyticsStat, BarList, PAYMENT_LABELS, formatBps } from '@/features/reports/AnalyticsParts';
import { PrintReportButton } from '@/features/reports/PrintReportButton';
import { RangePicker, isRangeReady, rangeParams, type RangeValue } from '@/features/reports/RangePicker';
import { ApiError } from '@/api/client';
import { pharmacyApi } from '@/api/pharmacy';
import { formatMoney } from '@/lib/money';
import { dosageFormLabel } from '@/lib/pharmacy';
import { useAuth } from '@/hooks/useAuth';
import { useTabParam } from '@/hooks/useTabParam';

const PHARMACY_RANGES = [{ value: 'today', label: 'Today' }, { value: 'last7', label: '7 days' }, { value: 'last30', label: '30 days' }];
const isLocked = (error: unknown) => error instanceof ApiError && error.code === 'ADVANCED_ANALYTICS_REQUIRED';

export function PharmacyReportsPage() {
  const [tab, setTab] = useTabParam('tab', 'sales', ['sales', 'products', 'inventory', 'payments', 'staff', 'profit']);
  const { session, activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const money = (minor: number) => formatMoney(minor, currency);
  const hasAdvanced = session?.entitlement?.features?.advancedReports ?? false;
  const [range, setRange] = React.useState<RangeValue>({ preset: 'last30', from: '', to: '' });
  const { data, isLoading, error } = useQuery({ queryKey: ['pharmacy', 'reports', range], queryFn: () => pharmacyApi.reports(rangeParams(range)), enabled: hasAdvanced && isRangeReady(range), retry: false });

  if (!hasAdvanced || isLocked(error)) return <div className="p-4 lg:p-6"><AdvancedAnalyticsLocked /></div>;
  return <div className="space-y-5 p-4 lg:p-6">
    <PageHeader title="Advanced Analytics" description={data ? `${data.range.label} · ${format(parseISO(data.range.from), 'dd MMM')} – ${format(parseISO(data.range.to), 'dd MMM yyyy')}` : 'Detailed pharmacy performance, stock and expiry reporting'} actions={<PrintReportButton path="/pharmacy/reports/print" params={rangeParams(range)} disabled={!data} />} />
    <RangePicker value={range} onChange={setRange} presets={PHARMACY_RANGES} />
    {isLoading && <LoadingState label="Crunching the numbers…" />}
    {error && !isLocked(error) && <EmptyState title="Could not load the reports" description="Please try again." />}
    {data && <>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <AnalyticsStat label="Net sales" value={money(data.totals.netSalesMinor)} hint={`${data.totals.salesCount} sales · avg ${money(data.totals.averageBasketMinor)}`} />
        <AnalyticsStat label="Gross profit" value={money(data.totals.grossProfitMinor)} hint={`${formatBps(data.totals.marginBps)} margin`} tone={data.totals.grossProfitMinor < 0 ? 'danger' : undefined} />
        <AnalyticsStat label="Refunds" value={money(data.totals.returnAmountMinor)} hint={`${data.totals.returnCount} returns`} tone={data.totals.returnAmountMinor > 0 ? 'danger' : undefined} />
        <AnalyticsStat label="Inventory value" value={money(data.inventory.costMinor)} hint={`${data.inventory.units} units · ${data.inventory.batches} batches`} />
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <div className="overflow-x-auto"><TabsList className="h-auto min-w-max flex-wrap justify-start"><TabsTrigger value="sales">Sales</TabsTrigger><TabsTrigger value="products">Products</TabsTrigger><TabsTrigger value="inventory">Inventory & expiry</TabsTrigger><TabsTrigger value="payments">Payments</TabsTrigger><TabsTrigger value="staff">Staff</TabsTrigger><TabsTrigger value="profit">Profit</TabsTrigger></TabsList></div>

        <TabsContent value="sales" className="space-y-4">
          <AnalyticsCard title="Sales trend" icon={<TrendingUp className="h-4 w-4" />} isEmpty={data.trend.length === 0} empty="No sales in this period"><BarList rows={data.trend.map((row) => ({ key: row.date, label: format(parseISO(row.date), 'EEE d MMM'), value: row.netSalesMinor, detail: `${row.salesCount} sale(s) · profit ${money(row.grossProfitMinor)}` }))} formatValue={money} /></AnalyticsCard>
          <div className="grid gap-4 lg:grid-cols-3"><AnalyticsCard title="Prescription sales" icon={<Pill className="h-4 w-4" />}><p className="text-2xl font-semibold">{money(data.totals.prescriptionValueMinor)}</p><p className="text-sm text-muted-foreground">{data.totals.prescriptionSales} sale(s)</p></AnalyticsCard><AnalyticsCard title="Returns" icon={<ReturnsCardIcon />} isEmpty={data.returns.count === 0} empty="Nothing came back"><ReturnsCardBody returns={data.returns} currency={currency} /></AnalyticsCard><AnalyticsCard title="Voided sales" icon={<Ban className="h-4 w-4" />} isEmpty={data.voids.recent.length === 0} empty="No voids"><ul className="divide-y text-sm">{data.voids.recent.map((row) => <li key={row._id} className="py-2"><div className="flex justify-between"><span className="font-mono text-xs">{row.saleNumber}</span><span>{money(row.totalMinor)}</span></div><p className="truncate text-xs text-muted-foreground">{row.voidedByNameSnapshot} · {row.voidReason}</p></li>)}</ul></AnalyticsCard></div>
        </TabsContent>

        <TabsContent value="products" className="space-y-4">
          <AnalyticsCard title="Medicine performance" icon={<Pill className="h-4 w-4" />} isEmpty={data.medicines.length === 0} empty="Nothing sold in this period"><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-muted-foreground"><th className="pb-2">Medicine</th><th className="pb-2 text-right">Sold</th><th className="pb-2 text-right">Revenue</th><th className="pb-2 text-right">Profit</th><th className="pb-2 text-right">Margin</th></tr></thead><tbody className="divide-y">{data.medicines.map((row) => <tr key={row.medicineId}><td className="py-2">{row.name} <span className="text-muted-foreground">{row.strength}</span><span className="block text-xs text-muted-foreground">{row.genericName}</span></td><td className="text-right">{row.quantity}</td><td className="text-right font-medium">{money(row.revenueMinor)}</td><td className="text-right">{money(row.profitMinor)}</td><td className="text-right">{formatBps(row.marginBps)}</td></tr>)}</tbody></table></div></AnalyticsCard>
          <div className="grid gap-4 lg:grid-cols-2"><AnalyticsCard title="By dosage form" icon={<Package className="h-4 w-4" />}><BarList rows={data.dosageForms.map((row) => ({ key: row.dosageForm, label: dosageFormLabel(row.dosageForm), value: row.revenueMinor, detail: `${row.quantity} units` }))} formatValue={money} /></AnalyticsCard><AnalyticsCard title="Slow movers" icon={<Turtle className="h-4 w-4" />} isEmpty={data.slowMovers.length === 0} empty="Everything in stock sold"><ul className="divide-y text-sm">{data.slowMovers.map((row) => <li key={row.medicineId} className="flex justify-between py-2"><span>{row.name} {row.strength}</span><span className="text-right">{money(row.stockCostMinor)}<span className="block text-xs text-muted-foreground">{row.units} units</span></span></li>)}</ul></AnalyticsCard></div>
        </TabsContent>

        <TabsContent value="inventory" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4"><AnalyticsStat label="Sellable units" value={String(data.inventory.sellableUnits)} /><AnalyticsStat label="Expired units" value={String(data.inventory.expiredUnits)} tone={data.inventory.expiredUnits ? 'danger' : undefined} /><AnalyticsStat label="Batches" value={String(data.inventory.batches)} /><AnalyticsStat label="At cost" value={money(data.inventory.costMinor)} /></div>
          <AnalyticsCard title="Expiry exposure" icon={<CalendarClock className="h-4 w-4" />}><BarList rows={[['Expired', data.expiry.expired], ['Within 30 days', data.expiry.within30], ['31–60 days', data.expiry.within60], ['61–90 days', data.expiry.within90]].map(([label, value]) => ({ key: String(label), label: String(label), value: (value as typeof data.expiry.expired).costMinor, detail: `${(value as typeof data.expiry.expired).units} units` }))} formatValue={money} /></AnalyticsCard>
          <AnalyticsCard title="Expiry batch details" icon={<CalendarClock className="h-4 w-4" />} isEmpty={data.expiryBatches.length === 0} empty="No stock expires within 90 days"><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-muted-foreground"><th className="pb-2">Medicine</th><th className="pb-2">Manufacturer</th><th className="pb-2">Batch</th><th className="pb-2">Expiry</th><th className="pb-2 text-right">Units</th><th className="pb-2 text-right">At cost</th></tr></thead><tbody className="divide-y">{data.expiryBatches.map((row) => <tr key={row.batchId}><td className="py-2">{row.name} {row.strength}</td><td>{row.manufacturer || '—'}</td><td className="font-mono text-xs">{row.batchNumber}</td><td className={row.daysToExpiry < 0 ? 'text-destructive' : ''}>{format(parseISO(row.expiryDate), 'dd MMM yyyy')}<span className="block text-xs text-muted-foreground">{row.daysToExpiry < 0 ? `${Math.abs(row.daysToExpiry)} days overdue` : `${row.daysToExpiry} days left`}</span></td><td className="text-right">{row.quantityOnHand}</td><td className="text-right">{money(row.costMinor)}</td></tr>)}</tbody></table></div></AnalyticsCard>
          <AnalyticsCard title="Write-offs" icon={<Trash2 className="h-4 w-4" />} isEmpty={data.writeOffs.byMedicine.length === 0} empty="Nothing written off"><ul className="divide-y text-sm">{data.writeOffs.byMedicine.map((row) => <li key={row.medicineId} className="flex justify-between py-2"><span>{row.units} × {row.name}</span><span className="text-destructive">{money(row.costMinor)}</span></li>)}</ul></AnalyticsCard>
        </TabsContent>

        <TabsContent value="payments" className="space-y-4"><AnalyticsCard title="Payments taken" icon={<CreditCard className="h-4 w-4" />} isEmpty={data.payments.length === 0} empty="No payments"><BarList rows={data.payments.map((row) => ({ key: row.method, label: PAYMENT_LABELS[row.method] ?? row.method, value: row.amountMinor, detail: `${row.sales} sale(s)` }))} formatValue={money} /></AnalyticsCard></TabsContent>

        <TabsContent value="staff" className="space-y-4"><AnalyticsCard title="Staff performance" icon={<Users className="h-4 w-4" />} isEmpty={data.staff.length === 0} empty="No staff sales in this period"><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-muted-foreground"><th className="pb-2">Staff</th><th className="pb-2 text-right">Sales</th><th className="pb-2 text-right">Items</th><th className="pb-2 text-right">Revenue</th><th className="pb-2 text-right">Discounts</th><th className="pb-2 text-right">Profit</th><th className="pb-2 text-right">Average</th></tr></thead><tbody className="divide-y">{data.staff.map((row) => <tr key={row.userId}><td className="py-2 font-medium">{row.name}</td><td className="text-right">{row.sales}</td><td className="text-right">{row.items}</td><td className="text-right">{money(row.netSalesMinor)}</td><td className="text-right">{money(row.discountsMinor)}</td><td className="text-right">{money(row.grossProfitMinor)}</td><td className="text-right">{money(row.averageBasketMinor)}</td></tr>)}</tbody></table></div></AnalyticsCard><AnalyticsCard title="Discounts by staff" icon={<Percent className="h-4 w-4" />} isEmpty={data.discounts.byStaff.length === 0} empty="No discounts given"><BarList rows={data.discounts.byStaff.map((row, index) => ({ key: row.userId ?? String(index), label: row.name, value: row.discountsMinor, detail: `${row.sales} sale(s)` }))} formatValue={money} /></AnalyticsCard></TabsContent>

        <TabsContent value="profit" className="space-y-4"><div className="grid gap-4 lg:grid-cols-2"><AnalyticsCard title="Profit & loss" icon={<TrendingUp className="h-4 w-4" />}><dl className="space-y-3 text-sm">{[['Gross sales', data.totals.grossSalesMinor], ['Discounts', data.totals.discountsMinor], ['Refunds', data.totals.returnAmountMinor], ['Net sales', data.totals.netSalesMinor], ['Cost of goods sold', data.totals.costMinor], ['Gross profit', data.totals.grossProfitMinor]].map(([label, value]) => <div key={String(label)} className="flex justify-between border-b pb-2 last:border-0"><dt>{label}</dt><dd className="font-medium">{money(Number(value))}</dd></div>)}</dl></AnalyticsCard><AnalyticsCard title="Losses & adjustments" icon={<Trash2 className="h-4 w-4" />}><dl className="space-y-3 text-sm"><div className="flex justify-between"><dt>Returns at cost</dt><dd>{money(data.returns.costMinor)}</dd></div><div className="flex justify-between"><dt>Write-offs at cost</dt><dd>{money(data.writeOffs.costMinor)}</dd></div><div className="flex justify-between"><dt>Voided sales value</dt><dd>{money(data.voids.valueMinor)}</dd></div><div className="flex justify-between border-t pt-3 font-medium"><dt>Gross margin</dt><dd>{formatBps(data.totals.marginBps)}</dd></div></dl></AnalyticsCard></div></TabsContent>
      </Tabs>
    </>}
  </div>;
}
