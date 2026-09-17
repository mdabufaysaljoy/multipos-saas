import { Link } from 'react-router-dom';
import { BarChart3, Check, Lock, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';

const UNLOCKS = [
  'Advanced sales analytics',
  'Profit analytics',
  'Product performance',
  'Variant performance',
  'Historical comparisons',
  'Advanced reports',
  'Business insights',
];

/**
 * What a plan without Advanced Analytics sees instead of the analytics screen.
 *
 * Rendered in place of the tabs, so no analytics request is ever made. The
 * server rejects those requests anyway (ADVANCED_ANALYTICS_REQUIRED); this
 * screen is what keeps the page looking intentional rather than broken.
 */
export function AdvancedAnalyticsLocked() {
  const { can } = useAuth();
  const canUpgrade = can('subscription.view');

  return (
    <Card className="mx-auto max-w-2xl">
      <CardContent className="flex flex-col items-center gap-5 p-6 text-center sm:p-10">
        <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <BarChart3 className="h-7 w-7" />
          <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border bg-background text-foreground">
            <Lock className="h-3.5 w-3.5" />
          </span>
        </div>

        <div className="space-y-1.5">
          <h2 className="flex items-center justify-center gap-2 text-xl font-semibold">
            Advanced Analytics <span aria-hidden>🔒</span>
          </h2>
          <p className="text-sm text-muted-foreground">
            Advanced Analytics is available with Professional and Enterprise subscriptions.
          </p>
        </div>

        <div className="w-full rounded-lg border bg-muted/40 p-4 text-left">
          <p className="mb-3 text-sm font-medium">Upgrade your subscription to unlock:</p>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {UNLOCKS.map((item) => (
              <li key={item} className="flex items-center gap-2">
                <Check className="h-4 w-4 shrink-0 text-success" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        {canUpgrade ? (
          <Button asChild size="lg">
            <Link to="/subscription">
              <Sparkles />
              Upgrade Subscription
            </Link>
          </Button>
        ) : (
          <p className="text-sm font-medium">Ask your store owner to upgrade the subscription.</p>
        )}

        <p className="text-xs text-muted-foreground">
          Your{' '}
          <Link to="/dashboard" className="font-medium text-foreground underline underline-offset-2">
            Dashboard
          </Link>{' '}
          stays available on every plan.
        </p>
      </CardContent>
    </Card>
  );
}
