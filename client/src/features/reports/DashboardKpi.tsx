import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface DashboardKpiProps {
  icon?: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  /** Pass both to show the change against the previous period of equal length. */
  now?: number;
  before?: number;
  tone?: 'danger';
}

/**
 * One headline figure on a POS dashboard, with its change against the previous
 * period. Shared by every vertical so a range comparison reads the same
 * whether the till sells shirts, groceries, medicine or biryani.
 */
export function DashboardKpi({ icon, label, value, hint, now, before, tone }: DashboardKpiProps) {
  const hasComparison = now !== undefined && before !== undefined;
  // A previous period of zero has no percentage to give, so say so in words.
  const change = hasComparison && before > 0 ? ((now - before) / before) * 100 : null;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </div>
        <p className={cn('tabular mt-1 text-2xl font-semibold', tone === 'danger' && 'text-destructive')}>{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        {hasComparison &&
          (change === null ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{now > 0 ? 'Nothing in the previous period' : 'No change'}</p>
          ) : Math.abs(change) < 0.05 ? (
            <p className="mt-0.5 text-xs text-muted-foreground">No change vs previous</p>
          ) : (
            <p className={cn('mt-0.5 flex items-center gap-0.5 text-xs font-medium', change > 0 ? 'text-success' : 'text-destructive')}>
              {change > 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
              {Math.abs(change).toFixed(1)}% vs previous
            </p>
          ))}
      </CardContent>
    </Card>
  );
}
