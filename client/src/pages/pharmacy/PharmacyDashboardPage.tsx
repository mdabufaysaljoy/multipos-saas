import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { AlertTriangle, ArrowRight, Banknote, CalendarClock, CreditCard, Package, PackageMinus, TrendingUp, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { RangePicker, isRangeReady, rangeParams, type RangeValue } from '@/features/reports/RangePicker';
import { DashboardKpi } from '@/features/reports/DashboardKpi';
import { AnalyticsCard, BarList, PAYMENT_LABELS } from '@/features/reports/AnalyticsParts';
import { pharmacyApi } from '@/api/pharmacy';
import { formatMoney } from '@/lib/money';
import { expiryTone, formatExpiry } from '@/lib/pharmacy';
import { useAuth } from '@/hooks/useAuth';

const PHARMACY_RANGES = [{ value: 'today', label: 'Today' }, { value: 'last7', label: '7 days' }, { value: 'last30', label: '30 days' }];

/** Pharmacy-only trading, stock and expiry overview. */
export function PharmacyDashboardPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const money = (minor: number) => formatMoney(minor, currency);
  const [range, setRange] = React.useState<RangeValue>({ preset: 'today', from: '', to: '' });
  const { data, isLoading, isError } = useQuery({ queryKey: ['pharmacy', 'dashboard', range], queryFn: () => pharmacyApi.dashboard(rangeParams(range)), enabled: isRangeReady(range) });

  return <div className="space-y-5 p-4 lg:p-6">
    <PageHeader title="Dashboard" description={data ? `${data.range.label} · ${format(parseISO(data.range.from), 'dd MMM')} – ${format(parseISO(data.range.to), 'dd MMM yyyy')}` : activeStore?.name ?? 'Your pharmacy at a glance'} actions={<Button asChild variant="outline"><Link to="/analytics">Advanced Analytics <ArrowRight className="ml-2 h-4 w-4" /></Link></Button>} />
    <RangePicker value={range} onChange={setRange} presets={PHARMACY_RANGES} />
    {isLoading && <LoadingState label="Loading your numbers…" />}
    {isError && <EmptyState title="Could not load the dashboard" description="Please try again." />}
    {data && <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 xl:grid-cols-4">
        <DashboardKpi icon={<Banknote className="h-4 w-4" />} label="Net sales" value={money(data.kpis.netSalesMinor)} hint={`${data.kpis.salesCount} sales · ${data.kpis.refundCount} refunds`} now={data.kpis.netSalesMinor} before={data.previous.totalMinor} />
        <DashboardKpi icon={<TrendingUp className="h-4 w-4" />} label="Gross profit" value={money(data.kpis.grossProfitMinor)} hint={`Cost ${money(data.kpis.costMinor)}`} tone={data.kpis.grossProfitMinor < 0 ? 'danger' : undefined} />
        <DashboardKpi icon={<Wallet className="h-4 w-4" />} label="Refunds" value={money(data.kpis.refundedMinor)} hint={`${data.kpis.refundCount} return(s)`} tone={data.kpis.refundedMinor > 0 ? 'danger' : undefined} />
        <DashboardKpi icon={<Package className="h-4 w-4" />} label="Stock value" value={money(data.stock.costMinor)} hint={`${data.stock.units} units · ${data.stock.batches} batches`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <AnalyticsCard title="Sales trend" icon={<TrendingUp className="h-4 w-4" />} className="lg:col-span-2" isEmpty={data.trend.length === 0} empty="No sales in this period"><BarList rows={data.trend.map((row) => ({ key: row.bucket, label: row.bucket, value: row.netSalesMinor, detail: `${row.salesCount} sale(s) · profit ${money(row.grossProfitMinor)}` }))} formatValue={money} /></AnalyticsCard>
        <AnalyticsCard title="Payments taken" icon={<CreditCard className="h-4 w-4" />} isEmpty={data.payments.length === 0} empty="No payments yet"><BarList rows={data.payments.map((row) => ({ key: row.method, label: PAYMENT_LABELS[row.method] ?? row.method, value: row.amountMinor, detail: `${row.sales} sale(s)` }))} formatValue={money} /></AnalyticsCard>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <AnalyticsCard title="Expiry details" icon={<CalendarClock className="h-4 w-4" />}><div className="mb-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm"><p className="font-medium text-destructive">{data.expired.units} expired unit(s)</p><p className="text-xs text-muted-foreground">{data.expired.batches} batches · {money(data.expired.costMinor)} at cost</p></div>{data.expiringSoon.length === 0 ? <p className="text-sm text-muted-foreground">Nothing expires in the next 30 days.</p> : <ul className="divide-y text-sm">{data.expiringSoon.map((batch) => { const tone = expiryTone(batch.expiryDate); return <li key={batch.batchId} className="flex items-center justify-between gap-3 py-2"><div className="min-w-0"><p className="truncate font-medium">{batch.medicineName} {batch.strength}</p><p className="truncate text-xs text-muted-foreground"><span className="font-mono">{batch.batchNumber}</span> · {formatExpiry(batch.expiryDate)} · {batch.quantityOnHand} left</p></div><Badge variant={tone.variant}>{tone.label}</Badge></li>; })}</ul>}</AnalyticsCard>
        <AnalyticsCard title="Top medicines" icon={<Package className="h-4 w-4" />} isEmpty={data.topMedicines.length === 0} empty="Nothing sold yet"><ul className="divide-y text-sm">{data.topMedicines.map((row) => <li key={row.medicineId} className="flex justify-between gap-3 py-2"><span className="truncate">{row.name} <span className="text-muted-foreground">{row.strength}</span></span><span className="shrink-0 text-right font-medium">{money(row.revenueMinor)}<span className="block text-xs font-normal text-muted-foreground">{row.quantity} units</span></span></li>)}</ul></AnalyticsCard>
        <AnalyticsCard title="Low stock now" icon={<PackageMinus className="h-4 w-4" />} isEmpty={data.lowStock.length === 0} empty="Stock levels look healthy"><ul className="divide-y text-sm">{data.lowStock.map((row) => <li key={row.medicineId} className="flex justify-between gap-3 py-2"><span className="truncate">{row.name} {row.strength}</span><span className={row.sellable === 0 ? 'text-destructive' : 'text-muted-foreground'}>{row.sellable} / {row.reorderLevel}</span></li>)}</ul></AnalyticsCard>
      </div>
      <AnalyticsCard title="Recent sales" icon={<AlertTriangle className="h-4 w-4" />} isEmpty={data.recentSales.length === 0} empty="No sales yet"><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-muted-foreground"><th className="pb-2">Sale</th><th className="pb-2">Customer</th><th className="pb-2">Staff</th><th className="pb-2 text-right">Items</th><th className="pb-2 text-right">Total</th></tr></thead><tbody className="divide-y">{data.recentSales.map((sale) => <tr key={sale.saleId}><td className="py-2 font-mono text-xs">{sale.saleNumber}<span className="block font-sans text-muted-foreground">{format(new Date(sale.soldAt), 'd MMM, h:mm a')}</span></td><td>{sale.customerName || 'Walk-in'}</td><td>{sale.cashierName}</td><td className="text-right">{sale.itemCount}</td><td className="text-right font-medium">{money(sale.totalMinor)}</td></tr>)}</tbody></table></div></AnalyticsCard>
    </>}
  </div>;
}
