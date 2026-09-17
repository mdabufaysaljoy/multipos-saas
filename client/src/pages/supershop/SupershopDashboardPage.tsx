import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PackageMinus, Receipt, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { supershopApi } from '@/api/supershop';
import { formatMoney } from '@/lib/money';
import { formatQuantity } from '@/lib/supershop';
import { useAuth } from '@/hooks/useAuth';

/** Today's trading, VAT collected, best sellers and what needs reordering, for this branch. */
export function SupershopDashboardPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const { data, isLoading } = useQuery({ queryKey: ['supershop', 'dashboard'], queryFn: supershopApi.dashboard });

  if (isLoading || !data) return <LoadingState label="Loading the dashboard…" />;

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader title="Dashboard" description={activeStore ? `${activeStore.name}, today` : 'Today'} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<Receipt className="h-4 w-4" />} label="Sales today" value={formatMoney(data.today.totalMinor, currency)} hint={`${data.today.salesCount} sale(s)`} />
        <Stat label="VAT collected today" value={formatMoney(data.today.vatMinor, currency)} />
        <Stat label="Gross profit today" value={formatMoney(data.today.grossProfitMinor, currency)} hint="After VAT and average cost" />
        <Stat label="This month" value={formatMoney(data.month.totalMinor, currency)} hint={`${data.month.salesCount} sale(s) · VAT ${formatMoney(data.month.vatMinor, currency)}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4" />
              Best sellers today
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.topProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sales yet today.</p>
            ) : (
              <ul className="divide-y text-sm">
                {data.topProducts.map((row) => (
                  <li key={row.productId} className="flex items-center justify-between gap-3 py-2">
                    <span className="font-medium">{row.name}</span>
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
              Needs reordering {data.lowStockCount > 0 ? `(${data.lowStockCount})` : ''}
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
                    <span className="font-medium">{row.name}</span>
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
    </div>
  );
}

function Stat({ icon, label, value, hint }: { icon?: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {label}
        </p>
        <p className="mt-1 text-xl font-semibold tabular">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
