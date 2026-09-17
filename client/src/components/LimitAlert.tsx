import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUsageLimits } from '@/hooks/useUsageLimits';
import { usageMessage } from '@/lib/usageLimits';
import { cn } from '@/lib/utils';

/**
 * A contextual warning on the page where a resource is created.
 *
 * The subscription page shows every limit; this shows only the one that matters
 * here, and only once it is worth saying. Silence below 80% is the point - a
 * banner that is always there is furniture, not a warning.
 */
export function LimitAlert({ resource, className }: { resource: string; className?: string }) {
  const { forResource, planName, nextPlanFor } = useUsageLimits();
  const status = forResource(resource);

  if (!status || status.level === 'ok') return null;

  const message = usageMessage(status, planName);
  const upgrade = nextPlanFor(status);
  const blocked = status.level === 'full';

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm',
        blocked ? 'border-destructive/30 bg-destructive/5' : 'border-warning/30 bg-warning/5',
        className,
      )}
    >
      {blocked ? (
        <Ban className="h-4 w-4 shrink-0 text-destructive" />
      ) : (
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
      )}
      <p className={cn('min-w-0 flex-1', blocked ? 'text-destructive' : 'text-warning')}>
        {message}
        {upgrade && (
          <span className="ml-1 font-normal text-muted-foreground">
            {upgrade.name} includes {upgrade.allowance} {status.noun}.
          </span>
        )}
      </p>
      <Button size="sm" variant={blocked ? 'default' : 'outline'} asChild>
        <Link to="/subscription">
          {blocked ? 'Upgrade' : 'See plans'}
          <ArrowRight />
        </Link>
      </Button>
    </div>
  );
}
