import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { Banknote, PackageMinus, Percent, Receipt, TrendingUp, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { DASHBOARD_PRESETS, RangePicker, isRangeReady, rangeParams, type RangeValue } from '@/features/reports/RangePicker';
import { DashboardKpi } from '@/features/reports/DashboardKpi';
import { supershopApi } from '@/api/supershop';
import { formatMoney } from '@/lib/money';
import { formatQuantity } from '@/lib/supershop';
import { useAuth } from '@/hooks/useAuth';

/**
 * Trading, VAT and margin for the chosen range, and what needs reordering now.
 *
 * Trading figures follow the range and are compared with the period before it;
 * the reorder list is always the shelf as it stands.
 */
export function SupershopDashboardPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const [range, setRange] = React.useState<RangeValue>({ preset: 'today', from: '', to: '' });

  const { data, isLoading, isError } = useQuery({
    queryKey: ['supershop', 'dashboard', range],
    queryFn: () => supershopApi.dashboard(rangeParams(range)),
    enabled: isRangeReady(range),
  });

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader
        title="Dashboard"
        description={
          data
            ? `${activeStore ? `${activeStore.name} · ` : ''}${data.range.label} · ${format(parseISO(data.range.from), 'dd MMM')} – ${format(parseISO(data.range.to), 'dd MMM yyyy')}`
            : activeStore?.name ?? 'Your shop at a glance'
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
              icon={<Receipt className="h-4 w-4" />}
              label="VAT collected"
              value={formatMoney(data.kpis.vatMinor, currency)}
              hint="Held for the government, not earned"
            />
            <DashboardKpi
              icon={<Percent className="h-4 w-4" />}
              label="Gross profit"
              value={formatMoney(data.kpis.grossProfitMinor, currency)}
              hint="After VAT and average cost"
              now={data.kpis.grossProfitMinor}
              before={data.previous.grossProfitMinor}
            />
            <DashboardKpi
              icon={<Wallet className="h-4 w-4" />}
              label="Average sale"
              value={formatMoney(data.kpis.averageSaleMinor, currency)}
              hint={data.kpis.discountMinor > 0 ? `${formatMoney(data.kpis.discountMinor, currency)} discounts` : undefined}
              now={data.kpis.averageSaleMinor}
              before={data.previous.averageSaleMinor}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <TrendingUp className="h-4 w-4" />
                  Best sellers
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.topProducts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sales in this period.</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {data.topProducts.map((row) => (
                      <li key={row.productId} className="flex items-center justify-between gap-3 py-2">
                        <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                        <span className="tabular text-muted-foreground">
                          {formatQuantity(row.quantity, row.unitType)} · <span className="text-foreground">{formatMoney(row.totalMinor, currency)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <PackageMinus className="h-4 w-4" />
                  Needs reordering now {data.lowStockCount > 0 ? `(${data.lowStockCount})` : ''}
                </CardTitle>
                <Link to="/shop-products" className="text-sm text-primary hover:underline">
                  Products
                </Link>
              </CardHeader>
              <CardContent>
                {data.lowStock.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Everything is above its reorder level.</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {data.lowStock.map((row) => (
                      <li key={row.productId} className="flex items-center justify-between gap-3 py-2">
                        <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                        <span className="tabular text-muted-foreground">
                          <span className={row.quantityOnHand === 0 ? 'text-destructive' : ''}>{formatQuantity(row.quantityOnHand, row.unitType)}</span> / reorder at{' '}
                          {formatQuantity(row.reorderLevel, row.unitType)}
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
