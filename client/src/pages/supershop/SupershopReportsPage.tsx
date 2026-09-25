import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { Ban, Clock, CreditCard, Layers, Percent, ReceiptText, ShoppingBasket, Snowflake, Trash2, TrendingUp } from 'lucide-react';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { AdvancedAnalyticsLocked } from '@/features/reports/AdvancedAnalyticsLocked';
import { ReturnsCardBody, ReturnsCardIcon } from '@/features/reports/ReturnsCard';
import { AnalyticsCard, AnalyticsStat, BarList, PAYMENT_LABELS, formatBps } from '@/features/reports/AnalyticsParts';
import { PrintReportButton } from '@/features/reports/PrintReportButton';
import { REPORT_PRESETS, RangePicker, isRangeReady, rangeParams, type RangeValue } from '@/features/reports/RangePicker';
import { ApiError } from '@/api/client';
import { supershopApi } from '@/api/supershop';
import { formatMoney } from '@/lib/money';
import { formatQuantity, formatVatRate } from '@/lib/supershop';
import { useAuth } from '@/hooks/useAuth';

const isLocked = (error: unknown) => error instanceof ApiError && error.code === 'ADVANCED_ANALYTICS_REQUIRED';

/**
 * Supershop Advanced Analytics for this branch. Locked (not hidden) on plans
 * without it; the server refuses the data regardless of what this screen decides.
 */
export function SupershopReportsPage() {
  const { session, activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const money = (minor: number) => formatMoney(minor, currency);
  const hasAdvanced = session?.entitlement?.features?.advancedReports ?? false;
  const [range, setRange] = React.useState<RangeValue>({ preset: 'last30', from: '', to: '' });

  const { data, isLoading, error } = useQuery({
    queryKey: ['supershop', 'reports', range],
    queryFn: () => supershopApi.reports(rangeParams(range)),
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

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Advanced Analytics"
        description={
          data
            ? `${data.range.label} · ${format(parseISO(data.range.from), 'dd MMM')} – ${format(parseISO(data.range.to), 'dd MMM yyyy')}`
            : 'Margin, VAT, best sellers, busy hours and dead stock'
        }
        actions={<PrintReportButton path="/supershop/reports/print" params={rangeParams(range)} disabled={!data} />}
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
                  : `${data.totals.salesCount} sales · ${data.totals.averageLines} lines per basket`
              }
            />
            <AnalyticsStat label="VAT collected" value={money(data.totals.vatMinor)} hint="Included in net sales" />
            <AnalyticsStat
              label="Gross profit"
              value={money(data.totals.grossProfitMinor)}
              hint={`${formatBps(data.totals.marginBps)} margin excluding VAT`}
              tone={data.totals.grossProfitMinor < 0 ? 'danger' : undefined}
            />
            <AnalyticsStat label="Average basket" value={money(data.totals.averageBasketMinor)} hint={`Discounts ${money(data.totals.discountsMinor)}`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <AnalyticsCard title="Daily sales" icon={<TrendingUp className="h-4 w-4" />} isEmpty={data.trend.length === 0} empty="No sales in this period">
              <BarList
                rows={data.trend.map((row) => ({
                  key: row.date,
                  label: format(parseISO(row.date), 'EEE d MMM'),
                  value: row.netSalesMinor,
                  detail: `${row.salesCount} sale(s) · VAT ${money(row.vatMinor)} · profit ${money(row.grossProfitMinor)}`,
                }))}
                formatValue={money}
              />
            </AnalyticsCard>

            <AnalyticsCard title="Best sellers" icon={<ShoppingBasket className="h-4 w-4" />} className="lg:col-span-2" isEmpty={data.products.length === 0} empty="Nothing sold in this period">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 font-medium">Product</th>
                    <th className="pb-2 text-right font-medium">Sold</th>
                    <th className="pb-2 text-right font-medium">Revenue</th>
                    <th className="pb-2 text-right font-medium">Profit</th>
                    <th className="pb-2 text-right font-medium">Margin</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.products.map((row) => (
                    <tr key={row.productId}>
                      <td className="py-2">{row.name}</td>
                      <td className="tabular py-2 text-right">{formatQuantity(row.quantity, row.unitType)}</td>
                      <td className="tabular py-2 text-right font-medium">{money(row.revenueMinor)}</td>
                      <td className="tabular py-2 text-right">{money(row.profitMinor)}</td>
                      <td className="tabular py-2 text-right text-muted-foreground">{formatBps(row.marginBps)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted-foreground">Per line, before sale discounts and returns. Profit excludes VAT.</p>
            </AnalyticsCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <AnalyticsCard title="Departments" icon={<Layers className="h-4 w-4" />} isEmpty={data.departments.length === 0} empty="No sales">
              <BarList
                rows={data.departments.map((row) => ({ key: row.department, label: row.department, value: row.revenueMinor, detail: `${row.lines} line(s) · profit ${money(row.profitMinor)}` }))}
                formatValue={money}
              />
            </AnalyticsCard>

            <AnalyticsCard title="VAT by rate" icon={<ReceiptText className="h-4 w-4" />} isEmpty={data.vatRates.length === 0} empty="No sales">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 font-medium">Rate</th>
                    <th className="pb-2 text-right font-medium">Sales</th>
                    <th className="pb-2 text-right font-medium">Excl. VAT</th>
                    <th className="pb-2 text-right font-medium">VAT</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.vatRates.map((row) => (
                    <tr key={row.vatRateBps}>
                      <td className="py-2">{formatVatRate(row.vatRateBps)}</td>
                      <td className="tabular py-2 text-right">{money(row.grossMinor)}</td>
                      <td className="tabular py-2 text-right">{money(row.netOfVatMinor)}</td>
                      <td className="tabular py-2 text-right font-medium">{money(row.vatMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted-foreground">Per line, before sale discounts and returns. VAT actually collected: {money(data.totals.vatMinor)}.</p>
            </AnalyticsCard>

            <AnalyticsCard title="Busy hours" icon={<Clock className="h-4 w-4" />} isEmpty={data.hours.length === 0} empty="No sales">
              <BarList
                rows={data.hours.map((row) => ({ key: row.hour, label: `${row.hour}:00`, value: row.netSalesMinor, detail: `${row.salesCount} sale(s)` }))}
                formatValue={money}
              />
            </AnalyticsCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-4">
            <AnalyticsCard title="Returns" icon={<ReturnsCardIcon />} isEmpty={data.returns.count === 0} empty="Nothing came back">
              <ReturnsCardBody returns={data.returns} currency={currency} />
            </AnalyticsCard>

            <AnalyticsCard title="Dead stock" icon={<Snowflake className="h-4 w-4" />} isEmpty={data.deadStock.length === 0} empty="Everything in stock sold at least once">
              <ul className="divide-y text-sm">
                {data.deadStock.map((row) => (
                  <li key={row.productId} className="flex items-center justify-between gap-3 py-2">
                    <span className="truncate">{row.name}</span>
                    <span className="tabular shrink-0 text-right">
                      {money(row.stockCostMinor)}
                      <span className="block text-xs text-muted-foreground">{formatQuantity(row.quantityOnHand, row.unitType)}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">In stock with no sales in this period, at average cost.</p>
            </AnalyticsCard>

            <AnalyticsCard title="Payments" icon={<CreditCard className="h-4 w-4" />} isEmpty={data.payments.length === 0} empty="No payments">
              <BarList
                rows={data.payments.map((row) => ({ key: row.method, label: PAYMENT_LABELS[row.method] ?? row.method, value: row.amountMinor, detail: `${row.sales} sale(s)` }))}
                formatValue={money}
              />
            </AnalyticsCard>

            <AnalyticsCard title="Write-offs" icon={<Trash2 className="h-4 w-4" />} isEmpty={data.writeOffs.byProduct.length === 0} empty="Nothing written off">
              <ul className="divide-y text-sm">
                {data.writeOffs.byProduct.map((row) => (
                  <li key={row.productId} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="truncate">
                      {formatQuantity(row.quantity, row.unitType)} × {row.name}
                    </span>
                    <span className="tabular text-destructive">{money(row.costMinor)}</span>
                  </li>
                ))}
              </ul>
            </AnalyticsCard>

            <AnalyticsCard title="Voids & discounts" icon={<Ban className="h-4 w-4" />} isEmpty={data.voids.recent.length === 0 && data.discounts.byStaff.length === 0} empty="No voids or discounts">
              <div className="space-y-3 text-sm">
                {data.voids.recent.length > 0 && (
                  <ul className="divide-y">
                    {data.voids.recent.map((row) => (
                      <li key={row._id} className="py-1.5">
                        <div className="flex justify-between gap-2">
                          <span className="font-mono text-xs">{row.saleNumber}</span>
                          <span className="tabular">{money(row.totalMinor)}</span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {format(new Date(row.voidedAt), 'd MMM hh:mm a')} · {row.voidReason}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {data.discounts.byStaff.length > 0 && (
                  <div className="border-t pt-2">
                    <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <Percent className="h-3 w-3" />
                      Discounts by staff
                    </p>
                    <ul className="divide-y">
                      {data.discounts.byStaff.map((row, index) => (
                        <li key={row.userId ?? index} className="flex justify-between gap-2 py-1.5">
                          <span className="truncate">{row.name}</span>
                          <span className="tabular">{money(row.discountsMinor)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </AnalyticsCard>
          </div>
        </>
      )}
    </div>
  );
}
