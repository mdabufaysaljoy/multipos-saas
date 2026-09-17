import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { Ban, ChefHat, Lock, Percent, Soup, Timer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { AdvancedAnalyticsLocked } from '@/features/reports/AdvancedAnalyticsLocked';
import { REPORT_PRESETS, RangePicker, isRangeReady, rangeParams, type RangeValue } from '@/features/reports/RangePicker';
import { Variance } from '@/pages/restaurant/ShiftsPage';
import { ApiError } from '@/api/client';
import { restaurantApi } from '@/api/restaurant';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';

const duration = (seconds: number) => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/**
 * Restaurant Advanced Analytics. Locked (not hidden) on plans without it; the
 * server refuses the data regardless of what this screen decides.
 */
export function RestaurantReportsPage() {
  const { session, activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const money = (minor: number) => formatMoney(minor, currency);
  const hasAdvanced = session?.entitlement?.features?.advancedReports ?? false;
  const [range, setRange] = React.useState<RangeValue>({ preset: 'last7', from: '', to: '' });

  const { data, isLoading, error } = useQuery({
    queryKey: ['restaurant', 'reports', range],
    queryFn: () => restaurantApi.reports(rangeParams(range)),
    enabled: hasAdvanced && isRangeReady(range),
    retry: false,
  });

  if (!hasAdvanced || (error instanceof ApiError && error.code === 'ADVANCED_ANALYTICS_REQUIRED')) {
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
            : 'Menu, voids, kitchen and cash drawer analysis'
        }
      />
      <RangePicker value={range} onChange={setRange} presets={REPORT_PRESETS} />

      {isLoading && <LoadingState label="Crunching the numbers…" />}
      {error && !(error instanceof ApiError && error.code === 'ADVANCED_ANALYTICS_REQUIRED') && (
        <EmptyState title="Could not load the reports" description="Please try again." />
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Net sales" value={money(data.totals.netSalesMinor)} hint={`${data.totals.paidOrders} paid orders`} />
            <Stat label="Discounts" value={money(data.totals.discountsMinor)} />
            <Stat
              label="Voids & cancellations"
              value={money(data.voids.valueMinor + data.cancellations.valueMinor)}
              hint={`${data.voids.quantity} items voided · ${data.cancellations.orders} orders cancelled`}
            />
            <Stat
              label="Cash variance"
              value={<Variance minor={data.shifts.closed ? data.shifts.totalVarianceMinor : null} currency={currency} />}
              hint={`${data.shifts.closed} closed shift${data.shifts.closed === 1 ? '' : 's'} · ${data.shifts.shortShifts} short`}
            />
          </div>

          {data.totals.unshiftedSalesMinor > 0 && (
            <p className="flex items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm">
              <Lock className="h-4 w-4" />
              {money(data.totals.unshiftedSalesMinor)} was paid while no shift was open, so it was never reconciled against a cash count.
            </p>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Soup className="h-4 w-4" />
                  Menu performance
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {data.menu.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Nothing sold in this period</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="pb-2 font-medium">Item</th>
                        <th className="pb-2 font-medium">Category</th>
                        <th className="pb-2 text-right font-medium">Sold</th>
                        <th className="pb-2 text-right font-medium">Revenue</th>
                        <th className="pb-2 text-right font-medium">Share</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {data.menu.map((row) => (
                        <tr key={row.menuItemId}>
                          <td className="py-2">{row.name}</td>
                          <td className="py-2 text-muted-foreground">{row.category}</td>
                          <td className="tabular py-2 text-right">{row.quantity}</td>
                          <td className="tabular py-2 text-right font-medium">{money(row.revenueMinor)}</td>
                          <td className="tabular py-2 text-right text-muted-foreground">
                            {data.totals.netSalesMinor > 0 ? `${((row.revenueMinor / data.totals.netSalesMinor) * 100).toFixed(1)}%` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">By category</CardTitle>
              </CardHeader>
              <CardContent>
                {data.categories.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No sales</p>
                ) : (
                  <ul className="divide-y">
                    {data.categories.map((row) => (
                      <li key={row.category} className="flex items-center gap-2 py-2 first:pt-0">
                        <span className="min-w-0 flex-1 truncate text-sm">{row.category}</span>
                        <Badge variant="secondary">{row.quantity}</Badge>
                        <span className="tabular w-24 text-right text-sm">{money(row.revenueMinor)}</span>
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
                <CardTitle className="flex items-center gap-2 text-base">
                  <ChefHat className="h-4 w-4" />
                  Kitchen speed
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.kitchen.tickets === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No tickets marked ready</p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="rounded-md border p-2">
                        <p className="text-xs text-muted-foreground">Average</p>
                        <p className="flex items-center gap-1 font-semibold">
                          <Timer className="h-3.5 w-3.5" />
                          {duration(data.kitchen.averagePrepSeconds)}
                        </p>
                      </div>
                      <div className="rounded-md border p-2">
                        <p className="text-xs text-muted-foreground">Slowest</p>
                        <p className="font-semibold">{duration(data.kitchen.slowestPrepSeconds)}</p>
                      </div>
                    </div>
                    <ul className="divide-y text-sm">
                      {data.kitchen.byHour.map((row) => (
                        <li key={row.hour} className="flex justify-between py-1.5">
                          <span className="tabular">{row.hour}</span>
                          <span className="text-muted-foreground">{row.tickets} tickets</span>
                          <span className="tabular font-medium">{duration(row.averagePrepSeconds)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Ban className="h-4 w-4" />
                  Voids & cancellations
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {data.voids.byItem.length === 0 && data.cancellations.recent.length === 0 && (
                  <p className="py-6 text-center text-muted-foreground">None in this period</p>
                )}
                {data.voids.byItem.length > 0 && (
                  <ul className="divide-y">
                    {data.voids.byItem.map((row) => (
                      <li key={row.menuItemId} className="flex justify-between gap-2 py-1.5">
                        <span className="truncate">
                          {row.quantity} × {row.name}
                        </span>
                        <span className="tabular text-destructive">{money(row.valueMinor)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {data.cancellations.recent.length > 0 && (
                  <div className="border-t pt-2">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cancelled orders</p>
                    <ul className="divide-y">
                      {data.cancellations.recent.map((row) => (
                        <li key={row._id} className="py-1.5">
                          <div className="flex justify-between gap-2">
                            <span className="font-mono text-xs">{row.orderNumber}</span>
                            <span className="tabular">{money(row.subtotalMinor)}</span>
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {format(new Date(row.cancelledAt), 'd MMM hh:mm a')} · {row.cancelReason}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Percent className="h-4 w-4" />
                  Discounts by staff
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.discounts.byStaff.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No discounts given</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {data.discounts.byStaff.map((row, index) => (
                      <li key={row.userId ?? index} className="flex items-center justify-between gap-2 py-1.5">
                        <span className="truncate">{row.name}</span>
                        <span className="text-xs text-muted-foreground">{row.orders} orders</span>
                        <span className="tabular font-medium">{money(row.discountsMinor)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Closed shifts</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {data.shifts.list.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No shifts closed in this period</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="pb-2 font-medium">Shift</th>
                      <th className="pb-2 font-medium">Closed</th>
                      <th className="pb-2 text-right font-medium">Expected</th>
                      <th className="pb-2 text-right font-medium">Counted</th>
                      <th className="pb-2 text-right font-medium">Variance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.shifts.list.map((s) => (
                      <tr key={s._id}>
                        <td className="py-2 font-mono text-xs">{s.shiftNumber}</td>
                        <td className="py-2">
                          {s.closedAt ? format(new Date(s.closedAt), 'd MMM hh:mm a') : '—'} · {s.closedByNameSnapshot}
                        </td>
                        <td className="tabular py-2 text-right">{s.expectedCashMinor === null ? '—' : money(s.expectedCashMinor)}</td>
                        <td className="tabular py-2 text-right">{s.countedCashMinor === null ? '—' : money(s.countedCashMinor)}</td>
                        <td className="py-2 text-right">
                          <Variance minor={s.varianceMinor} currency={currency} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <div className="tabular mt-1 text-2xl font-semibold">{value}</div>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
