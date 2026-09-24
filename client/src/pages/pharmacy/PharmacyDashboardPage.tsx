import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { AlertTriangle, Banknote, CalendarClock, FileText, PackageMinus, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { DASHBOARD_PRESETS, RangePicker, isRangeReady, rangeParams, type RangeValue } from '@/features/reports/RangePicker';
import { DashboardKpi } from '@/features/reports/DashboardKpi';
import { pharmacyApi } from '@/api/pharmacy';
import { formatMoney } from '@/lib/money';
import { expiryTone, formatExpiry } from '@/lib/pharmacy';
import { useAuth } from '@/hooks/useAuth';

/**
 * Trading for the chosen range, and what is low or about to expire right now.
 *
 * Trading figures follow the range and are compared with the period before it;
 * expiry and low stock describe the shelf as it stands, whatever the range.
 */
export function PharmacyDashboardPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const [range, setRange] = React.useState<RangeValue>({ preset: 'today', from: '', to: '' });

  const { data, isLoading, isError } = useQuery({
    queryKey: ['pharmacy', 'dashboard', range],
    queryFn: () => pharmacyApi.dashboard(rangeParams(range)),
    enabled: isRangeReady(range),
  });

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader
        title="Dashboard"
        description={
          data
            ? `${activeStore ? `${activeStore.name} · ` : ''}${data.range.label} · ${format(parseISO(data.range.from), 'dd MMM')} – ${format(parseISO(data.range.to), 'dd MMM yyyy')}`
            : activeStore?.name ?? 'Your pharmacy at a glance'
        }
      />

      <RangePicker value={range} onChange={setRange} presets={DASHBOARD_PRESETS} />

      {isLoading && <LoadingState label="Loading your numbers…" />}
      {isError && <EmptyState title="Could not load the dashboard" description="Please try again." />}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <DashboardKpi
              icon={<Banknote className="h-4 w-4" />}
              label="Sales"
              value={formatMoney(data.kpis.totalMinor, currency)}
              hint={`${data.kpis.salesCount} sale${data.kpis.salesCount === 1 ? '' : 's'}`}
              now={data.kpis.totalMinor}
              before={data.previous.totalMinor}
            />
            <DashboardKpi
              icon={<FileText className="h-4 w-4" />}
              label="Prescription sales"
              value={String(data.kpis.prescriptionSales)}
              hint={`of ${data.kpis.salesCount} sale${data.kpis.salesCount === 1 ? '' : 's'}`}
            />
            <DashboardKpi
              icon={<Wallet className="h-4 w-4" />}
              label="Average sale"
              value={formatMoney(data.kpis.averageSaleMinor, currency)}
              hint={data.kpis.discountMinor > 0 ? `${formatMoney(data.kpis.discountMinor, currency)} discounts` : undefined}
              now={data.kpis.averageSaleMinor}
              before={data.previous.averageSaleMinor}
            />
            <DashboardKpi
              icon={<AlertTriangle className="h-4 w-4" />}
              label="Expired on the shelf"
              value={`${data.expired.units} unit${data.expired.units === 1 ? '' : 's'}`}
              hint={data.expired.batches > 0 ? `${data.expired.batches} batch(es) · cost ${formatMoney(data.expired.costMinor, currency)}` : 'None'}
              tone={data.expired.units > 0 ? 'danger' : undefined}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex-row items-center justify-between pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarClock className="h-4 w-4" />
                  Expiring within 30 days
                </CardTitle>
                <Link to="/stock" className="text-sm text-primary hover:underline">
                  Stock
                </Link>
              </CardHeader>
              <CardContent>
                {data.expiringSoon.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing expires in the next 30 days.</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {data.expiringSoon.map((batch) => {
                      const tone = expiryTone(batch.expiryDate);
                      return (
                        <li key={batch.batchId} className="flex items-center justify-between gap-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate font-medium">
                              {batch.medicineName} {batch.strength}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              <span className="font-mono">{batch.batchNumber}</span> · exp {formatExpiry(batch.expiryDate)} · {batch.quantityOnHand} left
                            </p>
                          </div>
                          <Badge variant={tone.variant}>{tone.label}</Badge>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <PackageMinus className="h-4 w-4" />
                  Low stock now
                </CardTitle>
                <Link to="/medicines" className="text-sm text-primary hover:underline">
                  Medicines
                </Link>
              </CardHeader>
              <CardContent>
                {data.lowStock.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Everything is above its reorder level.</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {data.lowStock.map((row) => (
                      <li key={row.medicineId} className="flex items-center justify-between gap-3 py-2">
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {row.name} {row.strength}
                        </span>
                        <span className="tabular text-muted-foreground">
                          <span className={row.sellable === 0 ? 'text-destructive' : ''}>{row.sellable}</span> / reorder at {row.reorderLevel}
                        </span>
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
