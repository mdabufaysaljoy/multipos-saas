import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, FileText, PackageMinus, Receipt } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { pharmacyApi } from '@/api/pharmacy';
import { formatMoney } from '@/lib/money';
import { expiryTone, formatExpiry } from '@/lib/pharmacy';
import { useAuth } from '@/hooks/useAuth';

/** Today's trading, what is running low, and what is about to expire, for this branch. */
export function PharmacyDashboardPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const { data, isLoading } = useQuery({ queryKey: ['pharmacy', 'dashboard'], queryFn: pharmacyApi.dashboard });

  if (isLoading || !data) return <LoadingState label="Loading the dashboard…" />;

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader title="Dashboard" description={activeStore ? `${activeStore.name}, today` : 'Today'} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<Receipt className="h-4 w-4" />} label="Sales today" value={formatMoney(data.today.totalMinor, currency)} hint={`${data.today.salesCount} sale(s)`} />
        <Stat icon={<FileText className="h-4 w-4" />} label="Prescription sales today" value={String(data.today.prescriptionSales)} />
        <Stat label="This month" value={formatMoney(data.month.totalMinor, currency)} hint={`${data.month.salesCount} sale(s)`} />
        <Stat
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Expired on the shelf"
          value={`${data.expired.units} unit(s)`}
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
                      <div>
                        <p className="font-medium">
                          {batch.medicineName} {batch.strength}
                        </p>
                        <p className="text-xs text-muted-foreground">
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
              Low stock
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
                    <span className="font-medium">
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
    </div>
  );
}

function Stat({ icon, label, value, hint, tone }: { icon?: React.ReactNode; label: string; value: string; hint?: string; tone?: 'danger' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {label}
        </p>
        <p className={tone === 'danger' ? 'mt-1 text-xl font-semibold text-destructive tabular' : 'mt-1 text-xl font-semibold tabular'}>{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
