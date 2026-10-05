import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Layers3,
  ScanBarcode,
  ShieldCheck,
  Sparkles,
  Store,
  WalletCards,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AnalyticsPreview, ProductPreview } from '@/features/public/ProductPreview';
import { Reveal, SectionHeading } from '@/features/public/Reveal';
import { useTrialOffer } from '@/hooks/useTrialDays';
import { cn } from '@/lib/utils';
import { SAAS_PRODUCTS } from './products.data';

const FAQ = [
  [
    'Can I try RetailerSWs before paying?',
    'Yes. New workspaces start with the trial published by the platform, and no card is required to begin.',
  ],
  [
    'Can one account run different business types?',
    'Yes. Clothing, restaurant, super shop and pharmacy workspaces can live under one account, each with separate operations and subscriptions.',
  ],
  [
    'Will it work with barcode scanners and receipt printers?',
    'The supported POS flows include barcode checkout and thermal receipt printing. Hardware setup depends on the POS and device you use.',
  ],
  [
    'Can I control what staff can access?',
    'Yes. Staff roles and permissions are applied to each workspace, with server-side enforcement for protected actions.',
  ],
];

export function HomePage() {
  const { days: trialDays, planName: trialPlanName } = useTrialOffer();
  const [active, setActive] = React.useState(0);
  const product = SAAS_PRODUCTS[active];

  return (
    <>
      <section className="relative isolate overflow-hidden bg-slate-50">
        <div className="public-orb public-orb-one" aria-hidden="true" />
        <div className="public-orb public-orb-two" aria-hidden="true" />
        <div className="mx-auto grid min-h-[calc(100vh-4.5rem)] max-w-7xl items-center gap-14 px-4 py-16 sm:px-6 lg:grid-cols-[.88fr_1.12fr] lg:px-8 lg:py-20">
          <div className="relative z-10 max-w-2xl">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-indigo-200/70 bg-white/80 px-3 py-1.5 text-xs font-semibold text-indigo-700 shadow-sm backdrop-blur">
              <Sparkles className="h-3.5 w-3.5" /> One platform. Built for the business you run.
            </div>
            <h1 className="text-balance text-[2.8rem] font-bold leading-[1.02] tracking-[-.055em] text-slate-950 sm:text-6xl lg:text-[4.5rem]">
              Run every sale.
              <br />
              <span className="bg-gradient-to-r from-indigo-600 via-violet-600 to-cyan-500 bg-clip-text text-transparent">
                See the whole business.
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-pretty text-lg leading-8 text-slate-600">
              Purpose-built POS for retail, food and pharmacy—joined with inventory, staff control and insight in one
              polished workspace.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button size="xl" className="rounded-xl shadow-xl shadow-primary/20" asChild>
                <Link to="/register">
                  {trialDays ? `Start ${trialDays}-day free trial` : 'Start free trial'} <ArrowRight />
                </Link>
              </Button>
              <Button size="xl" variant="outline" className="rounded-xl border-slate-300 bg-white/70" asChild>
                <Link to="/products">Explore solutions</Link>
              </Button>
            </div>
            <div className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-xs font-medium text-slate-500">
              {['No card required', 'Setup in minutes', 'Scale when ready'].map((item) => (
                <span key={item} className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  {item}
                </span>
              ))}
            </div>
          </div>
          <div className="relative mx-auto w-full max-w-3xl lg:pl-5">
            <div className="absolute -left-4 -top-7 z-20 rounded-2xl border border-white/80 bg-white/90 p-3 shadow-xl backdrop-blur public-float">
              <p className="text-[9px] font-medium text-slate-500">Today’s sales</p>
              <p className="mt-1 text-lg font-bold text-slate-950">৳ 84,250</p>
              <p className="text-[9px] font-semibold text-emerald-600">↗ Healthy momentum</p>
            </div>
            <ProductPreview kind="supershop" className="relative z-10" />
            <div className="absolute -bottom-8 right-0 z-20 w-[55%] min-w-52 rotate-1">
              <AnalyticsPreview />
            </div>
          </div>
        </div>
        <div className="relative z-20 border-y border-slate-200/70 bg-white/70 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-8 gap-y-3 px-4 py-5 text-xs font-bold uppercase tracking-[.16em] text-slate-400 sm:px-6 lg:px-8">
            <span className="text-slate-600">Ready for</span>
            {['Independent shops', 'Restaurants', 'Fashion retail', 'Supermarkets', 'Pharmacies'].map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="px-4 py-24 sm:px-6 lg:px-8 lg:py-32">
        <Reveal>
          <SectionHeading
            eyebrow="Purpose-built solutions"
            title="One platform. A better fit for every counter."
            copy="Choose the workflow built for your trade, without giving up a shared account, wallet and operating view."
          />
        </Reveal>
        <div className="mx-auto mt-12 grid max-w-7xl gap-8 lg:grid-cols-[.78fr_1.22fr] lg:items-center">
          <div className="grid gap-2" role="tablist" aria-label="POS solutions">
            {SAAS_PRODUCTS.map((item, index) => (
              <button
                key={item.slug}
                type="button"
                role="tab"
                aria-selected={active === index}
                onClick={() => setActive(index)}
                className={cn(
                  'group flex w-full items-center gap-4 rounded-2xl p-4 text-left transition-all',
                  active === index ? 'bg-slate-950 text-white shadow-2xl shadow-slate-950/15' : 'hover:bg-slate-100',
                )}
              >
                <span
                  className={cn(
                    'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl',
                    active === index ? 'bg-white/10 text-cyan-300' : 'bg-slate-100 text-slate-600 group-hover:bg-white',
                  )}
                >
                  <item.icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{item.name}</span>
                  <span
                    className={cn(
                      'mt-0.5 block truncate text-xs',
                      active === index ? 'text-slate-400' : 'text-slate-500',
                    )}
                  >
                    {item.tagline}
                  </span>
                </span>
                <ChevronRight
                  className={cn('h-4 w-4 transition-transform', active === index && 'translate-x-1 text-cyan-300')}
                />
              </button>
            ))}
          </div>
          <Reveal
            className="relative rounded-[2rem] bg-gradient-to-br from-slate-100 to-indigo-50 p-5 sm:p-8"
            delay={120}
          >
            <ProductPreview kind={product.vertical} />
            <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-xl font-bold">{product.name}</h3>
                <p className="mt-1 max-w-lg text-sm leading-6 text-slate-600">{product.description}</p>
              </div>
              <Button variant="outline" className="shrink-0 rounded-xl bg-white" asChild>
                <Link to={`/products/${product.slug}`}>
                  See details <ArrowRight />
                </Link>
              </Button>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="overflow-hidden bg-slate-950 px-4 py-24 text-white sm:px-6 lg:px-8 lg:py-32">
        <div className="mx-auto grid max-w-7xl gap-14 lg:grid-cols-2 lg:items-center">
          <Reveal>
            <p className="text-xs font-bold uppercase tracking-[.22em] text-cyan-300">Clarity, built in</p>
            <h2 className="mt-4 text-balance text-3xl font-bold tracking-[-.04em] sm:text-5xl">
              From first scan to the numbers that move you forward.
            </h2>
            <p className="mt-5 max-w-xl text-lg leading-8 text-slate-400">
              The dashboard turns daily work into useful signals—sales, payments, inventory, profit and team
              activity—without making operators become analysts.
            </p>
            <div className="mt-8 grid gap-5 sm:grid-cols-2">
              {[
                [ScanBarcode, 'Fast at the counter', 'Search, scan, split and print with fewer interruptions.'],
                [BarChart3, 'Useful after the sale', 'See patterns, stock pressure and performance in context.'],
                [ShieldCheck, 'Controlled by design', 'Workspace isolation and role-aware access protect operations.'],
                [WalletCards, 'One connected account', 'Manage subscriptions and businesses from a shared foundation.'],
              ].map(([Icon, title, copy]) => {
                const FeatureIcon = Icon as typeof ScanBarcode;
                return (
                  <div key={title as string} className="flex gap-3">
                    <FeatureIcon className="mt-1 h-5 w-5 shrink-0 text-cyan-300" />
                    <div>
                      <h3 className="font-semibold">{title as string}</h3>
                      <p className="mt-1 text-sm leading-6 text-slate-400">{copy as string}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </Reveal>
          <Reveal delay={120}>
            <AnalyticsPreview className="ring-1 ring-white/10" />
          </Reveal>
        </div>
      </section>

      <section className="px-4 py-24 sm:px-6 lg:px-8 lg:py-32">
        <Reveal>
          <SectionHeading
            eyebrow="A shorter path to control"
            title="Open. Configure. Start selling."
            copy="The setup flow stays focused, so your business can move from account to first transaction without unnecessary ceremony."
          />
        </Reveal>
        <div className="mx-auto mt-14 grid max-w-6xl gap-8 md:grid-cols-3">
          {[
            [Store, '01', 'Create your workspace', 'Choose the POS that matches your business and add the essentials.'],
            [
              Layers3,
              '02',
              'Bring in your operation',
              'Add products, menu items, stock, branches and the people who need access.',
            ],
            [Clock3, '03', 'Sell and improve', 'Run the day, then use clear reports to make the next one better.'],
          ].map(([Icon, number, title, copy], index) => {
            const StepIcon = Icon as typeof Store;
            return (
              <Reveal key={number as string} delay={index * 80}>
                <div className="relative border-t border-slate-200 pt-6">
                  <span className="absolute -top-4 left-0 flex h-8 w-8 items-center justify-center rounded-full bg-slate-950 text-[10px] font-bold text-white">
                    {number as string}
                  </span>
                  <StepIcon className="mt-4 h-6 w-6 text-indigo-600" />
                  <h3 className="mt-5 text-lg font-bold">{title as string}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{copy as string}</p>
                </div>
              </Reveal>
            );
          })}
        </div>
      </section>

      <section className="bg-slate-50 px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[.7fr_1.3fr]">
          <Reveal>
            <SectionHeading
              align="left"
              eyebrow="Questions, answered"
              title="The essentials before you begin."
              copy="Everything important stays clear—from trial access to multi-business control."
            />
          </Reveal>
          <div className="divide-y divide-slate-200">
            {FAQ.map(([question, answer]) => (
              <details key={question} className="group py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                  <span>{question}</span>
                  <span className="text-xl font-light text-slate-400 transition group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">{answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="px-4 py-20 sm:px-6 lg:px-8">
        <Reveal className="mx-auto max-w-7xl overflow-hidden rounded-[2rem] bg-gradient-to-br from-indigo-600 via-violet-600 to-slate-950 px-6 py-14 text-center text-white shadow-2xl shadow-indigo-500/20 sm:px-12 lg:py-20">
          <p className="text-xs font-bold uppercase tracking-[.22em] text-cyan-200">Your next opening starts here</p>
          <h2 className="mx-auto mt-4 max-w-3xl text-balance text-3xl font-bold tracking-[-.04em] sm:text-5xl">
            A more capable business should feel easier to run.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-indigo-100">
            {trialDays
              ? `Start a ${trialDays}-day trial of ${trialPlanName ?? 'the available plan'}.`
              : 'Start your free trial.'}{' '}
            No card required.
          </p>
          <Button
            size="xl"
            variant="secondary"
            className="mt-8 rounded-xl bg-white text-slate-950 hover:bg-slate-100"
            asChild
          >
            <Link to="/register">
              Create your workspace <ArrowRight />
            </Link>
          </Button>
        </Reveal>
      </section>
    </>
  );
}
