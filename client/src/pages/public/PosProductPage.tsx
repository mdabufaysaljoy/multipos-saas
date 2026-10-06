import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check } from 'lucide-react';
import { billingApi } from '@/api/endpoints';
import { formatPlanPrice } from '@/lib/money';
import { formatLimit } from '@/lib/planCatalog';
import { cn } from '@/lib/utils';
import { Reveal, Stagger } from '@/features/public/motion';
import { Container, CtaButton, DarkSection, Eyebrow, SectionHeading } from '@/features/public/primitives';
import { PosTerminal, type TerminalVertical } from '@/features/public/PosTerminal';
import { productBySlug } from './products.data';

const ACCENT: Record<string, string> = {
  clothing: 'from-violet-500 to-fuchsia-500',
  restaurant: 'from-orange-500 to-rose-500',
  supershop: 'from-emerald-500 to-teal-500',
  pharmacy: 'from-cyan-500 to-blue-500',
};

const HEADLINE_LIMITS: { key: string; label: string }[] = [
  { key: 'maxStores', label: 'Branches' },
  { key: 'maxStaff', label: 'Staff' },
  { key: 'maxProducts', label: 'Products' },
];

/**
 * One POS, in full.
 *
 * The capability lists come from the shared product data; the plans come from
 * the API for THIS POS type, so a page can never promise a price or a limit the
 * backend would refuse.
 */
export function PosProductPage() {
  const { slug } = useParams();
  const product = productBySlug(slug);

  const { data: plans } = useQuery({
    queryKey: ['public', 'plans', product?.vertical],
    queryFn: () => billingApi.plansFor(product!.vertical),
    enabled: Boolean(product),
  });

  if (!product) return <Navigate to="/products" replace />;

  const monthly = (plans ?? [])
    .filter((plan) => plan.interval === 'monthly')
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .slice(0, 3);
  const accent = ACCENT[product.vertical];

  return (
    <>
      <DarkSection grid className="py-16 sm:py-24">
        <Container>
          <Reveal>
            <Link
              to="/products"
              className="group inline-flex items-center gap-1.5 rounded text-[0.8125rem] font-medium text-slate-400 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              <ArrowLeft className="h-3.5 w-3.5 transition-transform duration-300 group-hover:-translate-x-0.5" aria-hidden />
              All POS systems
            </Link>
          </Reveal>

          <div className="mt-10 grid items-center gap-14 lg:grid-cols-[1fr_1.05fr]">
            <div>
              <Reveal delay={60}>
                <Eyebrow>
                  <span className={cn('h-2 w-2 rounded-full bg-gradient-to-br', accent)} />
                  {product.tagline}
                </Eyebrow>
              </Reveal>
              <Reveal delay={120}>
                <h1 className="rs-display mt-6 text-[2.5rem] font-bold text-white sm:text-[3.25rem]">{product.name}</h1>
              </Reveal>
              <Reveal delay={180}>
                <p className="mt-6 max-w-lg text-pretty text-[1.0625rem] leading-8 text-slate-400">{product.description}</p>
              </Reveal>
              <Reveal delay={240}>
                <div className="mt-9 flex flex-wrap gap-3">
                  <CtaButton to="/register">Start free</CtaButton>
                  <CtaButton to="/pricing" variant="ghost">
                    See pricing
                  </CtaButton>
                </div>
              </Reveal>
            </div>

            <Reveal delay={200} from="none" scale={0.96}>
              <PosTerminal vertical={product.vertical as TerminalVertical} />
            </Reveal>
          </div>
        </Container>
      </DarkSection>

      {/* ------------------------------------------------- what it does */}
      <section className="bg-white py-20 sm:py-28">
        <Container>
          <SectionHeading eyebrow="Capabilities" title={<>What {product.name} does.</>} />
          <Stagger className="mt-14 grid gap-5 lg:grid-cols-3" step={90}>
            {product.features.map((group) => (
              <div key={group.title} className="rs-lift h-full rounded-2xl border border-slate-200 bg-white p-7">
                <h3 className="text-[1.0625rem] font-semibold text-slate-950">{group.title}</h3>
                <ul className="mt-5 space-y-3">
                  {group.items.map((item) => (
                    <li key={item} className="flex items-start gap-2.5 text-[0.875rem] leading-6 text-slate-600">
                      <Check className={cn('mt-0.5 h-4 w-4 shrink-0 text-indigo-600')} aria-hidden />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Stagger>
        </Container>
      </section>

      {/* ------------------------------------------------- plans for this POS */}
      {monthly.length > 0 && (
        <section className="border-t border-slate-200 bg-slate-50 py-20 sm:py-24">
          <Container>
            <SectionHeading
              eyebrow="Plans"
              title={<>Pricing for {product.name}.</>}
              copy="Read live from the platform, so what you see here is what the system charges."
            />
            <Stagger className="mt-12 grid gap-5 lg:grid-cols-3" step={90}>
              {monthly.map((plan) => (
                <div key={plan._id} className="rs-lift h-full rounded-[1.4rem] border border-slate-200 bg-white p-7">
                  <h3 className="text-[1.0625rem] font-semibold text-slate-950">{plan.name.replace(/ Annual$/, '')}</h3>
                  <p className="mt-5 flex items-baseline gap-1.5">
                    <span className="text-[2rem] font-bold tracking-tight text-slate-950">
                      {formatPlanPrice(plan.priceMinor, plan.currency)}
                    </span>
                    <span className="text-[0.8125rem] text-slate-400">/mo</span>
                  </p>
                  <dl className="mt-6 space-y-2.5 border-t border-slate-100 pt-5 text-[0.875rem]">
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
              ))}
            </Stagger>
            <Reveal delay={150}>
              <div className="mt-11 text-center">
                <CtaButton to="/pricing" variant="light" className="ring-1 ring-slate-200">
                  Compare every plan
                </CtaButton>
              </div>
            </Reveal>
          </Container>
        </section>
      )}

      <DarkSection className="py-20 sm:py-24">
        <Container>
          <div className="mx-auto max-w-2xl text-center">
            <Reveal>
              <h2 className="rs-h2 text-[2rem] font-bold text-white sm:text-[2.5rem]">
                Open your <span className="rs-gradient-text">{product.name}</span> today.
              </h2>
            </Reveal>
            <Reveal delay={120}>
              <div className="mt-9 flex flex-wrap justify-center gap-3">
                <CtaButton to="/register">Create a workspace</CtaButton>
                <CtaButton to="/contact" variant="ghost">
                  Talk to us
                </CtaButton>
              </div>
            </Reveal>
          </div>
        </Container>
      </DarkSection>
    </>
  );
}
