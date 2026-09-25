import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { Ban, CalendarClock, CreditCard, FileText, Percent, Pill, TrendingUp, Trash2, Turtle } from 'lucide-react';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { AdvancedAnalyticsLocked } from '@/features/reports/AdvancedAnalyticsLocked';
import { ReturnsCardBody, ReturnsCardIcon } from '@/features/reports/ReturnsCard';
import { AnalyticsCard, AnalyticsStat, BarList, PAYMENT_LABELS, formatBps } from '@/features/reports/AnalyticsParts';
import { REPORT_PRESETS, RangePicker, isRangeReady, rangeParams, type RangeValue } from '@/features/reports/RangePicker';
import { ApiError } from '@/api/client';
import { pharmacyApi } from '@/api/pharmacy';
import { formatMoney } from '@/lib/money';
import { DOSAGE_FORM_LABELS } from '@/lib/pharmacy';
import { useAuth } from '@/hooks/useAuth';
import type { DosageForm } from '@/types/pharmacy';

const isLocked = (error: unknown) => error instanceof ApiError && error.code === 'ADVANCED_ANALYTICS_REQUIRED';

/**
 * Pharmacy Advanced Analytics for this branch. Locked (not hidden) on plans
 * without it; the server refuses the data regardless of what this screen decides.
 */
export function PharmacyReportsPage() {
  const { session, activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const money = (minor: number) => formatMoney(minor, currency);
  const hasAdvanced = session?.entitlement?.features?.advancedReports ?? false;
  const [range, setRange] = React.useState<RangeValue>({ preset: 'last30', from: '', to: '' });

  const { data, isLoading, error } = useQuery({
    queryKey: ['pharmacy', 'reports', range],
    queryFn: () => pharmacyApi.reports(rangeParams(range)),
    enabled: hasAdvanced && isRangeReady(range),
    retry: false,
  });

  if (!hasAdvanced || isLocked(error)) {
    return (
      <div className="p-4 lg:p-6">
        <AdvancedAnalyticsLocked />
      </div>
    );
  }

  const expiryRows = data
    ? [
        { key: 'expired', label: 'Already expired, on the shelf', bucket: data.expiry.expired },
        { key: 'within30', label: 'Expires within 30 days', bucket: data.expiry.within30 },
        { key: 'within60', label: 'Expires in 31–60 days', bucket: data.expiry.within60 },
        { key: 'within90', label: 'Expires in 61–90 days', bucket: data.expiry.within90 },
      ]
    : [];

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Advanced Analytics"
        description={
          data
            ? `${data.range.label} · ${format(parseISO(data.range.from), 'dd MMM')} – ${format(parseISO(data.range.to), 'dd MMM yyyy')}`
            : 'Margin, prescriptions, expiry exposure and slow-moving stock'
        }
      />
      <RangePicker value={range} onChange={setRange} presets={REPORT_PRESETS} />

      {isLoading && <LoadingState label="Crunching the numbers…" />}
      {error && !isLocked(error) && <EmptyState title="Could not load the reports" description="Please try again." />}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <AnalyticsStat
              label="Net sales"
              value={money(data.totals.netSalesMinor)}
              hint={
                data.totals.returnAmountMinor > 0
                  ? `${money(data.totals.grossSalesMinor)} charged less ${money(data.totals.returnAmountMinor)} refunded · ${data.totals.salesCount} sales`
                  : `${data.totals.salesCount} sales · avg ${money(data.totals.averageBasketMinor)}`
              }
            />
            <AnalyticsStat
              label="Gross profit"
              value={money(data.totals.grossProfitMinor)}
              hint={`${formatBps(data.totals.marginBps)} margin · cost ${money(data.totals.costMinor)}`}
              tone={data.totals.grossProfitMinor < 0 ? 'danger' : undefined}
            />
            <AnalyticsStat label="Prescription sales" value={money(data.totals.prescriptionValueMinor)} hint={`${data.totals.prescriptionSales} sales`} />
            <AnalyticsStat
              label="Write-offs"
              value={money(data.writeOffs.costMinor)}
              hint={`${data.writeOffs.units} unit(s) at cost · ${data.voids.count} voided sale(s)`}
              tone={data.writeOffs.costMinor > 0 ? 'danger' : undefined}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <AnalyticsCard title="Daily sales" icon={<TrendingUp className="h-4 w-4" />} isEmpty={data.trend.length === 0} empty="No sales in this period">
              <BarList
                rows={data.trend.map((row) => ({
                  key: row.date,
                  label: format(parseISO(row.date), 'EEE d MMM'),
                  value: row.netSalesMinor,
                  detail: `${row.salesCount} sale(s) · profit ${money(row.grossProfitMinor)}`,
                }))}
                formatValue={money}
              />
            </AnalyticsCard>

            <AnalyticsCard title="Top medicines" icon={<Pill className="h-4 w-4" />} className="lg:col-span-2" isEmpty={data.medicines.length === 0} empty="Nothing sold in this period">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 font-medium">Medicine</th>
                    <th className="pb-2 text-right font-medium">Sold</th>
                    <th className="pb-2 text-right font-medium">Revenue</th>
                    <th className="pb-2 text-right font-medium">Profit</th>
                    <th className="pb-2 text-right font-medium">Margin</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.medicines.map((row) => (
                    <tr key={row.medicineId}>
                      <td className="py-2">
                        <p>
                          {row.name} <span className="text-muted-foreground">{row.strength}</span>
                        </p>
                        {row.genericName && <p className="text-xs text-muted-foreground">{row.genericName}</p>}
                      </td>
                      <td className="tabular py-2 text-right">{row.quantity}</td>
                      <td className="tabular py-2 text-right font-medium">{money(row.revenueMinor)}</td>
                      <td className="tabular py-2 text-right">{money(row.profitMinor)}</td>
                      <td className="tabular py-2 text-right text-muted-foreground">{formatBps(row.marginBps)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted-foreground">Line revenue and profit are before sale discounts ({money(data.discounts.totalMinor)} in this period).</p>
            </AnalyticsCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <AnalyticsCard title="Expiry exposure" icon={<CalendarClock className="h-4 w-4" />}>
              <ul className="divide-y text-sm">
                {expiryRows.map((row) => (
                  <li key={row.key} className="flex items-center justify-between gap-3 py-2">
                    <span className={row.key === 'expired' && row.bucket.units > 0 ? 'text-destructive' : ''}>{row.label}</span>
                    <span className="tabular text-right">
                      <span className="font-medium">{money(row.bucket.costMinor)}</span>
                      <span className="block text-xs text-muted-foreground">{row.bucket.units} unit(s)</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">Stock on hand now, valued at batch cost.</p>
            </AnalyticsCard>

            <AnalyticsCard title="Slow movers" icon={<Turtle className="h-4 w-4" />} isEmpty={data.slowMovers.length === 0} empty="Everything in stock sold at least once">
              <ul className="divide-y text-sm">
                {data.slowMovers.map((row) => (
                  <li key={row.medicineId} className="flex items-center justify-between gap-3 py-2">
                    <span className="truncate">
                      {row.name} <span className="text-muted-foreground">{row.strength}</span>
                    </span>
                    <span className="tabular shrink-0 text-right">
                      {money(row.stockCostMinor)}
                      <span className="block text-xs text-muted-foreground">{row.units} unit(s)</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">Unexpired stock with no sales in this period.</p>
            </AnalyticsCard>

            <AnalyticsCard title="By dosage form" icon={<FileText className="h-4 w-4" />} isEmpty={data.dosageForms.length === 0} empty="No sales">
              <BarList
                rows={data.dosageForms.map((row) => ({
                  key: row.dosageForm,
                  label: DOSAGE_FORM_LABELS[row.dosageForm as DosageForm] ?? row.dosageForm,
                  value: row.revenueMinor,
                  detail: `${row.quantity} unit(s)`,
                }))}
                formatValue={money}
              />
            </AnalyticsCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-4">
            <AnalyticsCard title="Payments" icon={<CreditCard className="h-4 w-4" />} isEmpty={data.payments.length === 0} empty="No payments">
              <BarList
                rows={data.payments.map((row) => ({ key: row.method, label: PAYMENT_LABELS[row.method] ?? row.method, value: row.amountMinor, detail: `${row.sales} sale(s)` }))}
                formatValue={money}
              />
            </AnalyticsCard>

            <AnalyticsCard title="Discounts by staff" icon={<Percent className="h-4 w-4" />} isEmpty={data.discounts.byStaff.length === 0} empty="No discounts given">
              <ul className="divide-y text-sm">
                {data.discounts.byStaff.map((row, index) => (
                  <li key={row.userId ?? index} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="truncate">{row.name}</span>
                    <span className="text-xs text-muted-foreground">{row.sales} sale(s)</span>
                    <span className="tabular font-medium">{money(row.discountsMinor)}</span>
                  </li>
                ))}
              </ul>
            </AnalyticsCard>

            <AnalyticsCard title="Returns" icon={<ReturnsCardIcon />} isEmpty={data.returns.count === 0} empty="Nothing came back">
              <ReturnsCardBody returns={data.returns} currency={currency} />
            </AnalyticsCard>

            <AnalyticsCard title="Write-offs" icon={<Trash2 className="h-4 w-4" />} isEmpty={data.writeOffs.byMedicine.length === 0} empty="Nothing written off">
              <ul className="divide-y text-sm">
                {data.writeOffs.byMedicine.map((row) => (
                  <li key={row.medicineId} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="truncate">
                      {row.units} × {row.name}
                    </span>
                    <span className="tabular text-destructive">{money(row.costMinor)}</span>
                  </li>
                ))}
              </ul>
            </AnalyticsCard>

            <AnalyticsCard title="Voided sales" icon={<Ban className="h-4 w-4" />} isEmpty={data.voids.recent.length === 0} empty="No voids">
              <ul className="divide-y text-sm">
                {data.voids.recent.map((row) => (
                  <li key={row._id} className="py-1.5">
                    <div className="flex justify-between gap-2">
                      <span className="font-mono text-xs">{row.saleNumber}</span>
                      <span className="tabular">{money(row.totalMinor)}</span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {format(new Date(row.voidedAt), 'd MMM hh:mm a')} · {row.voidedByNameSnapshot} · {row.voidReason}
                    </p>
                  </li>
                ))}
              </ul>
            </AnalyticsCard>
          </div>
        </>
      )}
    </div>
  );
}
