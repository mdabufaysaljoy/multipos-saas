import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Lock, Sparkles, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/states';
import { billingApi } from '@/api/endpoints';
import { formatPlanPrice } from '@/lib/money';
import { availableOn, formatLimit, upgradeHighlights } from '@/lib/planCatalog';
import { PlanComparisonTable } from '@/features/billing/PlanComparisonTable';
import { cn } from '@/lib/utils';
import { Reveal, Stagger } from '@/features/public/motion';
import { Container, CtaButton, DarkSection, SectionHeading } from '@/features/public/primitives';

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
 * Every price, limit and tick is read live from the API, so the page cannot
 * advertise something the backend does not enforce. The visual language is the
 * website's; the data and the rules are the platform's.
 */
export function PricingPage() {
  const [interval, setInterval] = React.useState<'monthly' | 'yearly'>('monthly');
  const { data: plans, isLoading } = useQuery({ queryKey: ['public', 'plans'], queryFn: billingApi.plans });

  const visible = (plans ?? []).filter((plan) => plan.interval === interval).sort((a, b) => a.sortOrder - b.sortOrder);

  // The trial belongs to ONE plan. `trialDays > 0` is the same rule the server
  // uses, so the page and the backend cannot disagree about who gets one.
  const trialPlan = (plans ?? []).filter((plan) => plan.trialDays > 0).sort((a, b) => a.tier - b.tier)[0] ?? null;
  const trialDays = trialPlan?.trialDays ?? null;
  const trialPlanName = trialPlan?.name.replace(/ Annual$/, '') ?? null;

  // Monthly equivalents, so the yearly view can show what paying monthly costs.
  const monthlyByTier = new Map((plans ?? []).filter((plan) => plan.interval === 'monthly').map((plan) => [plan.tier, plan]));

  return (
    <>
      <DarkSection grid className="py-20 sm:py-28">
        <Container>
          <SectionHeading
            tone="dark"
            eyebrow="Pricing"
            title={<>Pay for scale, not for the basics.</>}
            copy="Every plan includes the complete point of sale. You pay for more products, more staff and more branches — never for the till itself."
          />

          <Reveal delay={180}>
            <div className="mt-10 flex justify-center">
              <div role="radiogroup" aria-label="Billing interval" className="inline-flex rounded-full border border-white/10 bg-white/[0.04] p-1.5 backdrop-blur">
                {(['monthly', 'yearly'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={interval === value}
                    onClick={() => setInterval(value)}
                    className={cn(
                      'rounded-full px-6 py-2 text-sm font-semibold capitalize outline-none transition-all duration-300 focus-visible:ring-2 focus-visible:ring-indigo-400',
                      interval === value ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-400 hover:text-white',
                    )}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
          </Reveal>
        </Container>
      </DarkSection>

      <section className="bg-white py-20 sm:py-24">
        <Container>
          {isLoading && (
            <div className="grid gap-5 md:grid-cols-3">
              {[0, 1, 2].map((key) => (
                <div key={key} className="h-[30rem] animate-pulse rounded-[1.4rem] border border-slate-200 bg-slate-50" />
              ))}
            </div>
          )}
          {!isLoading && visible.length === 0 && <EmptyState title="No plans available" />}

          {visible.length > 0 && (
            <Stagger className="grid items-start gap-5 md:grid-cols-3" step={90}>
              {visible.map((plan, index) => {
                const featured = index === 1;
                const monthlyTwin = monthlyByTier.get(plan.tier);
                // Annual plans carry no trial, so ask the tier's monthly twin.
                const offersTrial = (monthlyTwin?.trialDays ?? plan.trialDays) > 0;
                const yearOfMonthly = monthlyTwin ? monthlyTwin.priceMinor * 12 : null;
                const saving = interval === 'yearly' && yearOfMonthly ? yearOfMonthly - plan.priceMinor : null;

                return (
                  <div
                    key={plan._id}
                    className={cn(
                      // The featured plan is the same card as the others, lifted
                      // by an accent ring rather than inverted to a dark slab -
                      // the three read as one set that way.
                      'rs-lift relative flex h-full flex-col rounded-[1.4rem] bg-white p-7',
                      featured
                        ? 'border-2 border-indigo-500 shadow-[0_32px_80px_-40px_rgba(79,70,229,0.45)] md:-my-4 md:py-11'
                        : 'border border-slate-200',
                    )}
                  >
                    {featured && (
                      <span className="absolute -top-3 left-7 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-slate-950">
                        <Sparkles className="h-3 w-3" aria-hidden />
                        Most popular
                      </span>
                    )}

                    <div className="flex items-start justify-between gap-3">
                      <h2 className="text-[1.125rem] font-semibold text-slate-950">{plan.name.replace(/ Annual$/, '')}</h2>
                      {offersTrial && (
                        <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                          Free trial
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-[0.8125rem] leading-5 text-slate-500">
                      {plan.description.replace(/ Billed yearly - two months free\.$/, '')}
                    </p>

                    <p className="mt-7 flex items-baseline gap-1.5">
                      <span className="text-[2.25rem] font-bold tracking-tight text-slate-950">
                        {formatPlanPrice(plan.priceMinor, plan.currency)}
                      </span>
                      <span className="text-[0.8125rem] text-slate-400">
                        / {plan.interval === 'yearly' ? 'year' : 'month'}
                      </span>
                    </p>
                    {saving !== null && saving > 0 && (
                      <p className="mt-1.5 text-[0.8125rem] font-medium text-emerald-600">
                        Saves {formatPlanPrice(saving, plan.currency)} a year
                      </p>
                    )}

                    <dl className="mt-7 space-y-2.5 border-t border-slate-100 pt-6 text-[0.875rem]">
                      {HEADLINE_LIMITS.map((limit) => (
                        <div key={limit.key} className="flex items-center justify-between gap-3">
                          <dt className="text-slate-500">{limit.label}</dt>
                          <dd className="font-mono font-semibold text-slate-900">{formatLimit(plan.limits[limit.key])}</dd>
                        </div>
                      ))}
                    </dl>

                    {/* Read from the plan's own flag, so the card cannot promise
                        what the backend will refuse. */}
                    <div className="mt-6 flex items-start gap-2 border-t border-slate-100 pt-5 text-[0.875rem]">
                      {plan.features.advancedReports ? (
                        <>
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                          <span className="font-medium text-slate-900">Advanced Analytics</span>
                        </>
                      ) : (
                        <>
                          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                          <span>
                            <span className="font-medium text-slate-900">Advanced Analytics</span>
                            <span className="block text-[0.75rem] text-slate-500">
                              Available on {availableOn(visible, 'advancedReports')}
                            </span>
                          </span>
                        </>
                      )}
                    </div>

                    <div className="flex-1" />

                    <Button
                      asChild
                      className={cn(
                        'mt-7 h-11 w-full rounded-full font-semibold',
                        featured
                          ? 'bg-gradient-to-r from-indigo-500 to-cyan-400 text-slate-950 hover:brightness-110'
                          : 'bg-slate-950 text-white hover:bg-slate-800',
                      )}
                    >
                      <Link to="/register">
                        {offersTrial ? 'Start free trial' : `Choose ${plan.name.replace(/ Annual$/, '')}`}
                        <ArrowRight />
                      </Link>
                    </Button>
                    {!offersTrial && trialPlanName && (
                      <p className="mt-3 text-center text-[0.75rem] text-slate-400">
                        Trials run on {trialPlanName}. Upgrade whenever you are ready.
                      </p>
                    )}
                  </div>
                );
              })}
            </Stagger>
          )}

          {/* ----------------------------------------------- upgrade paths */}
          {visible.length > 1 && (
            <Stagger className="mt-14 grid gap-4 sm:grid-cols-2" step={90}>
              {visible.slice(0, -1).map((plan, index) => {
                const next = visible[index + 1];
                const gains = upgradeHighlights(plan, next);
                if (gains.length === 0) return <span key={plan._id} className="hidden" />;
                return (
                  <div key={plan._id} className="rounded-2xl border border-slate-200 bg-slate-50 p-6">
                    <p className="flex items-center gap-2 text-[0.9375rem] font-semibold text-slate-950">
                      <Sparkles className="h-4 w-4 text-indigo-600" aria-hidden />
                      {plan.name.replace(/ Annual$/, '')} → {next.name.replace(/ Annual$/, '')}
                    </p>
                    <p className="mt-2 text-[0.875rem] leading-6 text-slate-600">Adds {gains.join(' · ')}.</p>
                  </div>
                );
              })}
            </Stagger>
          )}
        </Container>
      </section>

      {/* ------------------------------------------------ comparison table */}
      {visible.length > 0 && (
        <section className="border-y border-slate-200 bg-slate-50 py-20 sm:py-24">
          <Container>
            <SectionHeading
              eyebrow="Side by side"
              title={<>Compare every plan.</>}
              copy="Everything each plan includes, and everything it does not."
            />
            <Reveal delay={140}>
              <div className="mt-12 overflow-hidden rounded-[1.4rem] border border-slate-200 bg-white p-2 sm:p-4">
                <PlanComparisonTable plans={visible} />
              </div>
            </Reveal>
          </Container>
        </section>
      )}

      <DarkSection className="py-20 sm:py-24">
        <Container>
          <div className="mx-auto max-w-3xl">
            <Reveal>
              <div className="rs-ring rs-glass rounded-[1.4rem] p-8 sm:p-10">
                <p className="flex items-center gap-2 text-[0.9375rem] font-semibold text-white">
                  <Wallet className="h-4 w-4 text-indigo-400" aria-hidden />
                  How payment works
                </p>
                <p className="mt-4 text-[0.9375rem] leading-7 text-slate-400">
                  Every new workspace starts on a {trialDays ?? 7}-day free trial of {trialPlanName ?? 'Starter'} — no
                  card required. When you are ready, pay by bKash, Nagad or bank transfer and submit the transaction ID;
                  our team verifies it and your plan activates. You can also keep a prepaid balance in your wallet and
                  upgrade instantly from it.
                </p>
              </div>
            </Reveal>

            <Reveal delay={140}>
              <div className="mt-12 text-center">
                <CtaButton to="/register">Start free</CtaButton>
              </div>
            </Reveal>
          </div>
        </Container>
      </DarkSection>
    </>
  );
}
