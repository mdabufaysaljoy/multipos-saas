import type * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** "12.3%" from basis points. */
export const formatBps = (bps: number) => `${(bps / 100).toFixed(1)}%`;

export function AnalyticsStat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: 'danger' | 'success' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <div className={cn('tabular mt-1 text-2xl font-semibold', tone === 'danger' && 'text-destructive', tone === 'success' && 'text-success')}>{value}</div>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function AnalyticsCard({
  title,
  icon,
  className,
  empty,
  isEmpty,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  className?: string;
  empty?: string;
  isEmpty?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {isEmpty ? <p className="py-6 text-center text-sm text-muted-foreground">{empty ?? 'Nothing in this period'}</p> : children}
      </CardContent>
    </Card>
  );
}

/**
 * Horizontal bars scaled to the largest value. Plain elements, so it prints,
 * reads out to screen readers as a list, and costs no chart library.
 */
export function BarList({
  rows,
  formatValue,
}: {
  rows: { key: string; label: string; value: number; detail?: string }[];
  formatValue: (value: number) => string;
}) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.key} className="text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate">{row.label}</span>
            <span className="tabular shrink-0 font-medium">{formatValue(row.value)}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-muted" aria-hidden>
            <div className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }} />
          </div>
          {row.detail && <p className="mt-0.5 text-xs text-muted-foreground">{row.detail}</p>}
        </li>
      ))}
    </ul>
  );
}

export const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Cash',
  bkash: 'bKash',
  nagad: 'Nagad',
  card: 'Card',
  bank: 'Bank',
  other: 'Other',
};
