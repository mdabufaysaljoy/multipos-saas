import { cn } from '@/lib/utils';
import type { UsageStatus } from '@/lib/usageLimits';

// Three visibly different steps. 80% and 90% reading identically would make
// the second threshold pointless.
const BAR_TONE: Record<UsageStatus['level'], string> = {
  ok: 'bg-primary',
  warning: 'bg-warning/60',
  critical: 'bg-warning',
  full: 'bg-destructive',
};

const TEXT_TONE: Record<UsageStatus['level'], string> = {
  ok: '',
  warning: 'text-warning',
  critical: 'text-warning font-semibold',
  full: 'text-destructive font-semibold',
};

const CARD_TONE: Record<UsageStatus['level'], string> = {
  ok: '',
  warning: '',
  critical: 'border-warning/40 bg-warning/5',
  full: 'border-destructive/40 bg-destructive/5',
};

/**
 * One plan limit, with how much of it is gone.
 *
 * An unlimited resource shows "Unlimited" and no bar: a progress bar against
 * no ceiling is noise pretending to be information.
 */
export function UsageMeter({ status }: { status: UsageStatus }) {
  return (
    <div className={cn('rounded-md border p-3', CARD_TONE[status.level])}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{status.label}</span>
        <span className={cn('tabular text-sm font-semibold', TEXT_TONE[status.level])}>
          {status.usedLabel}
          <span className="font-normal text-muted-foreground">
            {status.unlimited ? '' : ` / ${status.maxLabel}`}
          </span>
        </span>
      </div>

      {status.unlimited ? (
        <p className="mt-1 text-xs text-muted-foreground">Unlimited</p>
      ) : (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all', BAR_TONE[status.level])}
              style={{ width: `${status.percent}%` }}
            />
          </div>
          {status.level !== 'ok' && (
            <p className={cn('mt-1.5 text-xs', TEXT_TONE[status.level])}>
              {status.level === 'full' && 'Limit reached — upgrade to add more'}
              {status.level === 'critical' &&
                `${status.percent}% used · only ${status.remaining.toLocaleString()} left`}
              {status.level === 'warning' && `${status.percent}% used · ${status.remaining.toLocaleString()} left`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
