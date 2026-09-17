import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Lock, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingState, EmptyState } from '@/components/states';
import { billingApi } from '@/api/endpoints';
import { formatPlanPrice } from '@/lib/money';
import { availableOn, formatLimit, upgradeHighlights } from '@/lib/planCatalog';
import { PlanComparisonTable } from '@/features/billing/PlanComparisonTable';
import { cn } from '@/lib/utils';

/** The six numbers that actually decide which plan someone needs. */
const HEADLINE_LIMITS: { key: string; label: string; format?: 'bytes' }[] = [
  { key: 'maxStores', label: 'Branches' },
  { key: 'maxStaff', label: 'Staff' },
  { key: 'maxProducts', label: 'Products' },
  { key: 'maxMonthlySales', label: 'Sales / month' },
  { key: 'maxCustomers', label: 'Customers' },
  { key: 'maxStorageBytes', label: 'Storage', format: 'bytes' as const },
];

/**
 * Public pricing.
 *
 * Every price, limit and tick is read live from the API and rendered through
 * the shared catalogue, so this page cannot advertise something the backend
 * does not enforce.
 */
export function PricingPage() {
  const [interval, setInterval] = React.useState<'monthly' | 'yearly'>('monthly');
  const { data: plans, isLoading } = useQuery({ queryKey: ['public', 'plans'], queryFn: billingApi.plans });

  const visible = (plans ?? [])
    .filter((plan) => plan.interval === interval)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // The trial belongs to ONE plan. `trialDays > 0` is the same rule the server
  // uses to decide eligibility, so the page and the backend cannot disagree
  // about who gets a free trial.
  const trialPlan = (plans ?? [])
    .filter((plan) => plan.trialDays > 0)
    .sort((a, b) => a.tier - b.tier)[0] ?? null;
  const trialDays = trialPlan?.trialDays ?? null;
  const trialPlanName = trialPlan?.name.replace(/ Annual$/, '') ?? null;

  // Monthly equivalents, so the yearly view can show what a year of paying
  // monthly would have cost.
  const monthlyByTier = new Map(
    (plans ?? []).filter((plan) => plan.interval === 'monthly').map((plan) => [plan.tier, plan]),
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 lg:px-6 lg:py-16">
      <header className="text-center">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Simple, honest pricing</h1>
        <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
          Every plan includes the complete point of sale. You pay for scale — more products, more staff, more
          branches — not for the basics.
        </p>
      </header>

      <div className="mt-8 flex flex-col items-center gap-2">
        <div className="inline-flex rounded-lg border bg-muted/40 p-1">
          <button
            type="button"
            onClick={() => setInterval('monthly')}
            className={cn(
              'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
              interval === 'monthly' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setInterval('yearly')}
            className={cn(
              'flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
              interval === 'yearly' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Yearly
            <Badge variant="success">2 months free</Badge>
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Annual billing charges ten months for twelve months of service.
        </p>
      </div>

      {isLoading && <LoadingState label="Loading plans…" />}
      {!isLoading && visible.length === 0 && <EmptyState title="No plans available" />}

      {/* ---------------------------------------------------------- cards */}
      <div className="mt-10 grid gap-6 md:grid-cols-3">
        {visible.map((plan, index) => {
          const featured = index === 1;
          const monthlyTwin = monthlyByTier.get(plan.tier);
          // Annual plans carry no trial, so ask the tier's monthly twin.
          const offersTrial = (monthlyTwin?.trialDays ?? plan.trialDays) > 0;
          const yearOfMonthly = monthlyTwin ? monthlyTwin.priceMinor * 12 : null;
          const saving = interval === 'yearly' && yearOfMonthly ? yearOfMonthly - plan.priceMinor : null;

          return (
            <Card
              key={plan._id}
              className={cn('flex flex-col', featured && 'border-primary shadow-md ring-1 ring-primary')}
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>{plan.name.replace(/ Annual$/, '')}</CardTitle>
                  {offersTrial && <Badge variant="success">Free trial</Badge>}
                  {featured && !offersTrial && <Badge>Most popular</Badge>}
                </div>
                <CardDescription>{plan.description.replace(/ Billed yearly - two months free\.$/, '')}</CardDescription>
              </CardHeader>

              <CardContent className="flex flex-1 flex-col gap-4">
                <div>
                  <p className="tabular text-3xl font-bold">
                    {formatPlanPrice(plan.priceMinor, plan.currency)}
                    <span className="text-base font-normal text-muted-foreground">
                      {' '}/ {plan.interval === 'yearly' ? 'year' : 'month'}
                    </span>
                  </p>
                  {saving !== null && saving > 0 && (
                    <p className="mt-1 text-xs font-medium text-success">
                      Saves {formatPlanPrice(saving, plan.currency)} a year
                    </p>
                  )}
                </div>

                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-4 text-sm">
                  {HEADLINE_LIMITS.map((limit) => (
                    <div key={limit.key}>
                      <dt className="text-xs text-muted-foreground">{limit.label}</dt>
                      <dd className="tabular font-semibold">
                        {formatLimit(plan.limits[limit.key], limit.format)}
                      </dd>
                    </div>
                  ))}
                </dl>

                {/* The analytics line is read from the plan's own flag, so the
                    card cannot promise what the backend will refuse. */}
                <div className="flex items-start gap-2 border-t pt-3 text-sm">
                  {plan.features.advancedReports ? (
                    <>
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                      <span className="font-medium">Advanced Analytics</span>
                    </>
                  ) : (
                    <>
                      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <span>
                        <span className="font-medium">Advanced Analytics</span>
                        <span className="block text-xs text-muted-foreground">
                          Available on {availableOn(visible, 'advancedReports')}
                        </span>
                      </span>
                    </>
                  )}
                </div>

                <div className="flex-1" />

                <Button className="w-full" variant={featured ? 'default' : 'outline'} asChild>
                  <Link to="/register">
                    {offersTrial ? 'Start free trial' : `Choose ${plan.name.replace(/ Annual$/, '')}`}
                    <ArrowRight />
                  </Link>
                </Button>
                {!offersTrial && trialPlanName && (
                  <p className="text-center text-xs text-muted-foreground">
                    Trials run on {trialPlanName}. Upgrade whenever you are ready.
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* ------------------------------------------------- upgrade paths */}
      {visible.length > 1 && (
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {visible.slice(0, -1).map((plan, index) => {
            const next = visible[index + 1];
            const gains = upgradeHighlights(plan, next);
            if (gains.length === 0) return null;
            return (
              <div key={plan._id} className="rounded-lg border bg-muted/30 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <Sparkles className="h-4 w-4 text-primary" />
                  {plan.name.replace(/ Annual$/, '')} → {next.name.replace(/ Annual$/, '')}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">Adds {gains.join(' · ')}.</p>
              </div>
            );
          })}
        </div>
      )}

      {/* ------------------------------------------------ comparison table */}
      {visible.length > 0 && (
        <section className="mt-14">
          <h2 className="text-center text-2xl font-bold tracking-tight">Compare every plan</h2>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            Everything each plan includes, and everything it does not.
          </p>

          <div className="mt-6">
            <PlanComparisonTable plans={visible} />
          </div>
        </section>
      )}

      <div className="mx-auto mt-12 max-w-2xl rounded-lg border bg-muted/40 p-5 text-sm">
        <p className="font-semibold">How payment works</p>
        <p className="mt-1 text-muted-foreground">
          Every new workspace starts on a {trialDays ?? 7}-day free trial of {trialPlanName ?? 'Starter'} — no
          card required. When you are ready, pay by bKash, Nagad or bank transfer and submit the transaction ID; our
          team verifies it and your plan activates. You can also keep a prepaid balance in your wallet and upgrade
          instantly from it.
        </p>
      </div>
    </div>
  );
}
