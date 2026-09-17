import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatPlanPrice } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { PlanOption } from '@/types/domain';

interface DowngradeDialogProps {
  plan: PlanOption | null;
  currentPlanName: string | null;
  onClose: () => void;
  /** Called when the tenant already fits and can proceed to payment. */
  onProceed: (plan: PlanOption) => void;
  /** Keep the current plan to the end of the period and switch at renewal. */
  onSchedule?: (plan: PlanOption) => void;
  scheduling?: boolean;
}

const RESOURCE_ROUTE: Record<string, string> = {
  branches: '/branches',
  staff: '/staff',
  products: '/catalogue',
};

/** A Restaurant's `products` meter is its menu; the server names it "menu items". */
const routeFor = (breach: { resource: string; label: string }): string | undefined =>
  breach.resource === 'products' && breach.label === 'menu items' ? '/menu' : RESOURCE_ROUTE[breach.resource];

/**
 * The downgrade requirement panel.
 *
 * Rather than simply disabling a button, this lists every resource that is over
 * the target plan's limit with the exact excess, and links to the screen where
 * the owner can fix it. Nothing is ever deleted automatically.
 *
 * When usage already fits, the same dialog turns into a plain confirmation -
 * the system works that out itself.
 */
export function DowngradeDialog({ plan, currentPlanName, onClose, onProceed, onSchedule, scheduling }: DowngradeDialogProps) {
  const navigate = useNavigate();
  if (!plan) return null;

  const blocked = plan.breaches.length > 0;

  return (
    <Dialog open={Boolean(plan)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div
              className={cn(
                'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                blocked ? 'bg-warning/12 text-warning' : 'bg-success/12 text-success',
              )}
            >
              {blocked ? <AlertTriangle className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
            </div>
            <div className="space-y-1">
              <DialogTitle>
                {blocked ? 'Reduce your usage before downgrading' : `Move to ${plan.name}?`}
              </DialogTitle>
              <DialogDescription>
                {blocked
                  ? `You are using more than ${plan.name} allows. Remove or deactivate the items below, then come back — nothing is deleted for you.`
                  : `Your workspace already fits inside the ${plan.name} limits, so you can move straight away.`}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Current plan</span>
            <span className="font-medium">{currentPlanName ?? '—'}</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-muted-foreground">Target plan</span>
            <span className="font-medium">
              {plan.name} · {formatPlanPrice(plan.priceMinor, plan.currency)} / {plan.interval === 'yearly' ? 'year' : 'month'}
            </span>
          </div>
        </div>

        {onSchedule && plan.catalogPlanCode && (
          <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            Moving now does not credit the time left on your current plan. Switch at the end of the period to keep it.
          </p>
        )}

        {blocked ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Required changes</p>
            {plan.breaches.map((breach) => (
              <div key={breach.resource} className="rounded-md border border-warning/30 bg-warning/5 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium capitalize">{breach.label}</span>
                  <Badge variant="warning">{breach.excess.toLocaleString()} over</Badge>
                </div>

                <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                  <div className="flex justify-between">
                    <dt>Current</dt>
                    <dd className="tabular font-medium text-foreground">{breach.current.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Allowed</dt>
                    <dd className="tabular font-medium text-foreground">{breach.limit.toLocaleString()}</dd>
                  </div>
                </dl>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-warning">{breach.action}</p>
                  {routeFor(breach) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0"
                      onClick={() => {
                        onClose();
                        navigate(routeFor(breach)!);
                      }}
                    >
                      Manage
                      <ArrowRight />
                    </Button>
                  )}
                </div>
              </div>
            ))}

            <p className="text-xs text-muted-foreground">
              Deactivating an item frees the slot without destroying its history, so past sales and reports stay intact.
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {Object.entries(plan.limits)
              .filter(([key]) => ['maxStores', 'maxStaff', 'maxProducts'].includes(key))
              .map(([key, value]) => (
                <li key={key} className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                  {key === 'maxStores' ? 'Branches' : key === 'maxStaff' ? 'Staff accounts' : 'Products'}:{' '}
                  {value === -1 ? 'unlimited' : value.toLocaleString()} allowed
                </li>
              ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {blocked ? 'Close' : 'Cancel'}
          </Button>
          {onSchedule && plan.catalogPlanCode && plan.billingCycle && (
            // Scheduling is allowed even while over the limits: they are checked at renewal.
            <Button variant="outline" loading={scheduling} onClick={() => onSchedule(plan)}>
              Switch at end of period
            </Button>
          )}
          {!blocked && (
            <Button onClick={() => onProceed(plan)}>
              Continue to payment
              <ArrowRight />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
