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
import { Reveal } from '@/features/public/Reveal';

/** The numbers that actually decide which plan someone needs. */
const HEADLINE_LIMITS: { key: string; label: string }[] = [
  { key: 'maxStores', label: 'Branches' },
  { key: 'maxStaff', label: 'Staff' },
  { key: 'maxProducts', label: 'Products' },
  { key: 'maxMonthlySales', label: 'Sales / month' },
  { key: 'maxCustomers', label: 'Customers' },
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

  const visible = (plans ?? []).filter((plan) => plan.interval === interval).sort((a, b) => a.sortOrder - b.sortOrder);

  // The trial belongs to ONE plan. `trialDays > 0` is the same rule the server
  // uses to decide eligibility, so the page and the backend cannot disagree
  // about who gets a free trial.
  const trialPlan = (plans ?? []).filter((plan) => plan.trialDays > 0).sort((a, b) => a.tier - b.tier)[0] ?? null;
  const trialDays = trialPlan?.trialDays ?? null;
  const trialPlanName = trialPlan?.name.replace(/ Annual$/, '') ?? null;

  // Monthly equivalents, so the yearly view can show what a year of paying
  // monthly would have cost.
  const monthlyByTier = new Map(
    (plans ?? []).filter((plan) => plan.interval === 'monthly').map((plan) => [plan.tier, plan]),
  );

  return (
    <div className="bg-[linear-gradient(to_bottom,#f8fafc_0,#fff_32rem)] px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
      <header className="mx-auto max-w-3xl text-center">
        <p className="text-xs font-bold uppercase tracking-[.22em] text-primary">Simple by design</p>
        <h1 className="mt-4 text-balance text-4xl font-bold tracking-[-.05em] text-slate-950 sm:text-6xl">
          Pricing that grows with the work.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-slate-600">
          Every plan includes the complete point of sale. You pay for scale — more products, more staff, more branches —
          not for the basics.
        </p>
      </header>

      <div className="mt-10 flex flex-col items-center gap-2">
        <div className="inline-flex rounded-full border border-slate-200 bg-white p-1.5 shadow-sm">
          <button
            type="button"
            onClick={() => setInterval('monthly')}
            className={cn(
              'rounded-full px-5 py-2 text-sm font-medium transition-colors',
              interval === 'monthly' ? 'bg-slate-950 text-white shadow-sm' : 'text-slate-500 hover:text-slate-950',
            )}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setInterval('yearly')}
            className={cn(
              'flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors',
              interval === 'yearly' ? 'bg-slate-950 text-white shadow-sm' : 'text-slate-500 hover:text-slate-950',
            )}
          >
            Yearly
            <Badge variant="success">2 months free</Badge>
          </button>
        </div>
        <p className="text-xs text-muted-foreground">Annual billing charges ten months for twelve months of service.</p>
      </div>

      {isLoading && <LoadingState label="Loading plans…" />}
      {!isLoading && visible.length === 0 && <EmptyState title="No plans available" />}

      {/* ---------------------------------------------------------- cards */}
      <div className="mx-auto mt-12 grid max-w-7xl gap-6 md:grid-cols-3">
        {visible.map((plan, index) => {
          const featured = index === 1;
          const monthlyTwin = monthlyByTier.get(plan.tier);
          // Annual plans carry no trial, so ask the tier's monthly twin.
          const offersTrial = (monthlyTwin?.trialDays ?? plan.trialDays) > 0;
          const yearOfMonthly = monthlyTwin ? monthlyTwin.priceMinor * 12 : null;
          const saving = interval === 'yearly' && yearOfMonthly ? yearOfMonthly - plan.priceMinor : null;

          return (
            <Reveal key={plan._id} delay={index * 70} className="h-full">
              <Card
                className={cn(
                  'flex h-full flex-col rounded-2xl border-slate-200 bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-xl',
                  featured && 'border-slate-950 bg-slate-950 text-white shadow-2xl shadow-slate-950/20 ring-0',
                )}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle>{plan.name.replace(/ Annual$/, '')}</CardTitle>
                    {offersTrial && <Badge variant="success">Free trial</Badge>}
                    {featured && !offersTrial && <Badge>Most popular</Badge>}
                  </div>
                  <CardDescription className={featured ? 'text-slate-400' : undefined}>
                    {plan.description.replace(/ Billed yearly - two months free\.$/, '')}
                  </CardDescription>
                </CardHeader>

                <CardContent className="flex flex-1 flex-col gap-4">
                  <div>
                    <p className="tabular text-3xl font-bold">
                      {formatPlanPrice(plan.priceMinor, plan.currency)}
                      <span className="text-base font-normal text-muted-foreground">
                        {' '}
                        / {plan.interval === 'yearly' ? 'year' : 'month'}
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
                        <dd className="tabular font-semibold">{formatLimit(plan.limits[limit.key])}</dd>
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

                  <Button
                    className={cn('w-full rounded-xl', featured && 'bg-white text-slate-950 hover:bg-slate-100')}
                    variant={featured ? 'default' : 'outline'}
                    asChild
                  >
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
            </Reveal>
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
        <section className="mx-auto mt-20 max-w-7xl">
          <h2 className="text-center text-2xl font-bold tracking-tight">Compare every plan</h2>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            Everything each plan includes, and everything it does not.
          </p>

          <div className="mt-6">
            <PlanComparisonTable plans={visible} />
          </div>
        </section>
      )}

      <div className="mx-auto mt-14 max-w-3xl rounded-2xl border border-slate-200 bg-slate-50 p-6 text-sm">
        <p className="font-semibold">How payment works</p>
        <p className="mt-1 text-muted-foreground">
          Every new workspace starts on a {trialDays ?? 7}-day free trial of {trialPlanName ?? 'Starter'} — no card
          required. When you are ready, pay by bKash, Nagad or bank transfer and submit the transaction ID; our team
          verifies it and your plan activates. You can also keep a prepaid balance in your wallet and upgrade instantly
          from it.
        </p>
      </div>
    </div>
  );
}
