import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Sparkles } from 'lucide-react';
import { billingApi } from '@/api/endpoints';
import { formatPlanPrice } from '@/lib/money';
import { formatLimit } from '@/lib/planCatalog';
import { cn } from '@/lib/utils';
import { Reveal, Stagger } from '@/features/public/motion';
import { Container, CtaButton, SectionHeading } from '@/features/public/primitives';

/** The three numbers that actually decide which plan someone needs. */
const HEADLINE_LIMITS: { key: string; label: string }[] = [
  { key: 'maxStores', label: 'Branches' },
  { key: 'maxStaff', label: 'Staff' },
  { key: 'maxProducts', label: 'Products' },
];

/**
 * Pricing, on the home page.
 *
 * Plans, prices, trial length and limits are read live from the same `/plans`
 * endpoint the billing pages use, so the site cannot advertise a number the
 * backend will not honour. Nothing here is hard-coded.
 */
export function PricingTeaser() {
  const [interval, setInterval] = React.useState<'monthly' | 'yearly'>('monthly');
  const { data: plans, isLoading } = useQuery({ queryKey: ['public', 'plans'], queryFn: billingApi.plans });

  const visible = (plans ?? []).filter((plan) => plan.interval === interval).sort((a, b) => a.sortOrder - b.sortOrder);
  const trialPlan = (plans ?? []).filter((plan) => plan.trialDays > 0).sort((a, b) => a.tier - b.tier)[0] ?? null;
  // The middle tier is the one most shops land on; it carries the emphasis.
  const featuredTier = visible.length > 2 ? visible[Math.floor(visible.length / 2)]?.tier : visible[0]?.tier;

  return (
    <section className="bg-white py-20 sm:py-28">
      <Container>
        <SectionHeading
          eyebrow="Pricing"
          title={<>Pay for scale, not for the basics.</>}
          copy="Every plan includes the complete point of sale. What changes is how much of it you need."
        />

        <Reveal delay={120}>
          <div className="mt-9 flex justify-center">
            <div role="radiogroup" aria-label="Billing interval" className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-1.5">
              {(['monthly', 'yearly'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={interval === value}
                  onClick={() => setInterval(value)}
                  className={cn(
                    'rounded-full px-5 py-2 text-sm font-semibold capitalize outline-none transition-all duration-300 focus-visible:ring-2 focus-visible:ring-indigo-400',
                    interval === value ? 'bg-slate-950 text-white shadow-sm' : 'text-slate-500 hover:text-slate-900',
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        </Reveal>

        {isLoading && (
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {[0, 1, 2].map((key) => (
              <div key={key} className="h-80 animate-pulse rounded-2xl border border-slate-200 bg-slate-50" />
            ))}
          </div>
        )}

        {!isLoading && visible.length > 0 && (
          <Stagger className="mt-12 grid items-start gap-5 lg:grid-cols-3" step={90}>
            {visible.slice(0, 3).map((plan) => {
              const featured = plan.tier === featuredTier;
              return (
                <div
                  key={plan._id}
                  className={cn(
                    // The featured plan is the same card as the others, lifted
                    // by an accent ring rather than inverted to a dark slab -
                    // the three read as one set that way.
                    'rs-lift relative h-full rounded-[1.4rem] bg-white p-7',
                    featured
                      ? 'border-2 border-indigo-500 shadow-[0_32px_80px_-40px_rgba(79,70,229,0.45)] lg:-my-3 lg:py-10'
                      : 'border border-slate-200',
                  )}
                >
                  {featured && (
                    <span className="absolute -top-3 left-7 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-slate-950">
                      <Sparkles className="h-3 w-3" aria-hidden />
                      Most chosen
                    </span>
                  )}

                  <h3 className="text-[1.125rem] font-semibold text-slate-950">{plan.name.replace(/ Annual$/, '')}</h3>
                  <p className="mt-1.5 text-[0.8125rem] leading-5 text-slate-500">{plan.description}</p>

                  <p className="mt-6 flex items-baseline gap-1.5">
                    <span className="text-[2.25rem] font-bold tracking-tight text-slate-950">
                      {formatPlanPrice(plan.priceMinor, plan.currency)}
                    </span>
                    <span className="text-[0.8125rem] text-slate-400">/{interval === 'monthly' ? 'mo' : 'yr'}</span>
                  </p>

                  <dl className="mt-7 space-y-2.5 border-t border-slate-100 pt-6 text-[0.875rem]">
                    {HEADLINE_LIMITS.map((limit) => (
                      <div key={limit.key} className="flex items-center justify-between gap-3">
                        <dt className="text-slate-500">{limit.label}</dt>
                        <dd className="font-mono font-semibold text-slate-900">{formatLimit(plan.limits[limit.key])}</dd>
                      </div>
                    ))}
                  </dl>

                  {plan.trialDays > 0 && (
                    <p className="mt-5 flex items-center gap-1.5 text-[0.8125rem] font-medium text-emerald-600">
                      <Check className="h-3.5 w-3.5" aria-hidden />
                      {plan.trialDays}-day free trial
                    </p>
                  )}
                </div>
              );
            })}
          </Stagger>
        )}

        <Reveal delay={160}>
          <div className="mt-12 flex flex-col items-center gap-4">
            <CtaButton to="/pricing" variant="light" className="ring-1 ring-slate-200">
              Compare every plan
            </CtaButton>
            {trialPlan && (
              <p className="text-[0.8125rem] text-slate-500">
                {trialPlan.trialDays} days free on {trialPlan.name.replace(/ Annual$/, '')}. No card required.
              </p>
            )}
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
