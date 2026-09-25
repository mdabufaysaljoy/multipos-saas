import { Undo2 } from 'lucide-react';
import { formatMoney } from '@/lib/money';
import type { PosReturnSummary } from '@/types/domain';

interface ReturnsCardProps {
  returns: { count: number; units: number; amountMinor: number; recent: PosReturnSummary[] };
  currency: string;
}

/**
 * What came back in the period.
 *
 * Next to voids, and not the same thing: a void cancels a sale that should
 * never have stood, a return gives money back on one that did. The list names
 * the reason and who took it, because that is what an owner asks about first.
 */
export function ReturnsCardBody({ returns, currency }: ReturnsCardProps) {
  const money = (minor: number) => formatMoney(minor, currency);
  return (
    <>
      <p className="tabular text-2xl font-semibold">{money(returns.amountMinor)}</p>
      <p className="text-xs text-muted-foreground">
        {returns.count} return{returns.count === 1 ? '' : 's'} · {returns.units} unit{returns.units === 1 ? '' : 's'}
      </p>
      <ul className="mt-3 divide-y text-sm">
        {returns.recent.map((row) => (
          <li key={row._id} className="py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-mono text-xs">{row.returnNumber}</span>
              <span className="tabular shrink-0">{money(row.totalMinor)}</span>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              against {row.saleNumber} · {row.reason} · {row.by}
              {row.notRestockedUnits > 0 ? ` · ${row.notRestockedUnits} not restocked` : ''}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

export const ReturnsCardIcon = () => <Undo2 className="h-4 w-4" />;
