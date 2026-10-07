import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BarChart3,
  Boxes,
  CreditCard,
  Fingerprint,
  Layers,
  Lock,
  Pill,
  Receipt,
  RefreshCw,
  ScanLine,
  Shirt,
  ShoppingBasket,
  Sparkles,
  Store,
  Users,
  Utensils,
  Wallet,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Counter, Reveal, Stagger } from '@/features/public/motion';
import { Container, CtaButton, DarkSection, Eyebrow, SectionHeading } from '@/features/public/primitives';
import { PosTerminal, type TerminalVertical } from '@/features/public/PosTerminal';
import { SAAS_PRODUCTS } from './products.data';
import { PricingTeaser } from './PricingTeaser';

/**
 * The Retailer Suites home page.
 *
 * Visual-first: every section carries its meaning in a product visual, and the
 * copy is there to name it rather than explain it. Nothing here claims a
 * capability the platform does not have - the POS list, the capability grid and
 * the plans all come from the same data the application itself uses.
 */
export function HomePage() {
  return (
    <>
      <Hero />
      <Ecosystem />
      <Showcase />
      <Capabilities />
      <HowItWorks />
      <Growth />
      <PricingTeaser />
      <Trust />
      <FinalCta />
    </>
  );
}

/* ========================================================================== */

function Hero() {
  return (
    <DarkSection grid className="pb-20 pt-14 sm:pb-28 sm:pt-20 lg:pb-32">
      <Container>
        <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.05fr] lg:gap-16">
          <div>
            <Reveal>
              <Eyebrow>
                <Sparkles className="h-3 w-3" aria-hidden />
                One platform · Four POS systems
              </Eyebrow>
            </Reveal>

            <Reveal delay={80}>
              <h1 className="rs-display mt-7 text-pretty text-[2.75rem] font-bold text-white sm:text-[3.75rem] lg:text-[4.25rem]">
                The counter,
                <br />
                <span className="rs-gradient-text">under control.</span>
              </h1>
            </Reveal>

            <Reveal delay={150}>
              <p className="mt-7 max-w-lg text-pretty text-[1.0625rem] leading-8 text-slate-400">
                Point of sale, stock and insight for clothing shops, restaurants, super shops and pharmacies — run from
                one account.
              </p>
            </Reveal>

            <Reveal delay={220}>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <CtaButton to="/register">Start free</CtaButton>
                <CtaButton to="/products" variant="ghost">
                  See the POS systems
                </CtaButton>
              </div>
            </Reveal>

            <Reveal delay={300}>
              <dl className="mt-12 grid max-w-md grid-cols-3 gap-6 border-t border-white/10 pt-7">
                {[
                  { value: 4, suffix: '', label: 'POS systems' },
                  { value: 5, suffix: '', label: 'Payment methods' },
                  { value: 100, suffix: '%', label: 'Priced server-side' },
                ].map((stat) => (
                  <div key={stat.label}>
                    <dt className="text-2xl font-bold text-white sm:text-[1.75rem]">
                      <Counter to={stat.value} suffix={stat.suffix} />
                    </dt>
                    <dd className="mt-1.5 text-[0.8125rem] leading-5 text-slate-500">{stat.label}</dd>
                  </div>
                ))}
              </dl>
            </Reveal>
          </div>

          <Reveal delay={180} from="none" scale={0.96}>
            <div className="rs-float-slow">
              <PosTerminal vertical="clothing" />
            </div>
          </Reveal>
        </div>
      </Container>
    </DarkSection>
  );
}

/* ========================================================================== */

const ECOSYSTEM: { vertical: TerminalVertical; slug: string; icon: typeof Shirt; accent: string }[] = [
  { vertical: 'clothing', slug: 'clothing-pos', icon: Shirt, accent: 'from-violet-500 to-fuchsia-500' },
  { vertical: 'restaurant', slug: 'restaurant-pos', icon: Utensils, accent: 'from-orange-500 to-rose-500' },
  { vertical: 'supershop', slug: 'super-shop-pos', icon: ShoppingBasket, accent: 'from-emerald-500 to-teal-500' },
  { vertical: 'pharmacy', slug: 'pharmacy-pos', icon: Pill, accent: 'from-cyan-500 to-blue-500' },
];

function Ecosystem() {
  const [active, setActive] = React.useState<TerminalVertical>('clothing');
  const product = SAAS_PRODUCTS.find((entry) => entry.vertical === active);
  const current = ECOSYSTEM.find((entry) => entry.vertical === active)!;

  return (
    <DarkSection className="border-t border-white/[0.06] py-20 sm:py-28">
      <Container>
        <SectionHeading
          tone="dark"
          eyebrow="The ecosystem"
          title={<>Four tills. One platform.</>}
          copy="Each POS is built for how that trade actually sells. Switch between them to see the counter change."
        />

        <div className="mt-14 grid gap-10 lg:grid-cols-[22rem_1fr] lg:gap-14">
          <div role="tablist" aria-label="POS systems" className="space-y-2.5">
            {ECOSYSTEM.map((entry, index) => {
              const entryProduct = SAAS_PRODUCTS.find((p) => p.vertical === entry.vertical);
              const selected = entry.vertical === active;
              return (
                <Reveal key={entry.vertical} delay={index * 70} from="right">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setActive(entry.vertical)}
                    className={cn(
                      'group w-full rounded-2xl border p-4 text-left outline-none transition-all duration-300 focus-visible:ring-2 focus-visible:ring-indigo-400',
                      selected
                        ? 'border-white/15 bg-white/[0.07] shadow-[0_20px_50px_-30px_rgba(79,70,229,0.9)]'
                        : 'border-white/[0.07] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.05]',
                    )}
                  >
                    <span className="flex items-center gap-3.5">
                      <span
                        className={cn(
                          'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br transition-transform duration-300 group-hover:scale-105',
                          entry.accent,
                        )}
                      >
                        <entry.icon className="h-5 w-5 text-white" aria-hidden />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[0.95rem] font-semibold text-white">{entryProduct?.name}</span>
                        <span className="block truncate text-[0.8125rem] text-slate-400">{entryProduct?.tagline}</span>
                      </span>
                      <ArrowRight
                        className={cn(
                          'ml-auto h-4 w-4 shrink-0 transition-all duration-300',
                          selected ? 'translate-x-0 text-white opacity-100' : '-translate-x-1 text-slate-500 opacity-0 group-hover:translate-x-0 group-hover:opacity-100',
                        )}
                        aria-hidden
                      />
                    </span>
                  </button>
                </Reveal>
              );
            })}
          </div>

          <div>
            {/* Keyed on the vertical so the till re-enters when it changes. */}
            <div key={active} className="rs-reveal is-in">
              <PosTerminal vertical={active} />
            </div>

            {product && (
              <div key={`${active}-meta`} className="rs-reveal is-in mt-8" style={{ '--rs-delay': '120ms' } as React.CSSProperties}>
                <ul className="grid gap-2.5 sm:grid-cols-2">
                  {product.highlights.map((highlight) => (
                    <li key={highlight} className="flex items-start gap-2.5 text-[0.875rem] text-slate-400">
                      <span className={cn('mt-[0.4rem] h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-br', current.accent)} />
                      {highlight}
                    </li>
                  ))}
                </ul>
                <Link
                  to={`/products/${current.slug}`}
                  className="group mt-6 inline-flex items-center gap-1.5 rounded text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  Explore {product.name}
                  <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </div>
            )}
          </div>
        </div>
      </Container>
    </DarkSection>
  );
}

/* ========================================================================== */

const SHOWCASE = [
  { icon: ScanLine, title: 'Billing', copy: 'Scan, split the tender, print the receipt.' },
  { icon: Boxes, title: 'Inventory', copy: 'Stock per branch, with a ledger behind every move.' },
  { icon: Layers, title: 'Products', copy: 'Variants, batches, weights — whatever the trade needs.' },
  { icon: Users, title: 'Customers', copy: 'Purchase history and loyalty on a scanned card.' },
  { icon: CreditCard, title: 'Payments', copy: 'Cash, bKash, Nagad, bank and card in one sale.' },
  { icon: Receipt, title: 'Orders', copy: 'Tables, tokens and order history for the kitchen.' },
  { icon: BarChart3, title: 'Analytics', copy: 'What sold, what it cost, what you kept.' },
  { icon: RefreshCw, title: 'Returns', copy: 'Refunds and exchanges against the original sale.' },
];

function Showcase() {
  return (
    <section className="relative bg-white py-20 sm:py-28">
      <Container>
        <SectionHeading
          eyebrow="What you get"
          title={<>Everything the counter touches.</>}
          copy="The same platform behind every POS, so a second shop is a second workspace — not a second system."
        />

        <Stagger className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" step={60}>
          {SHOWCASE.map((item) => (
            <div
              key={item.title}
              className="rs-lift group h-full rounded-2xl border border-slate-200 bg-white p-6 hover:border-indigo-200"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-950 text-white transition-colors duration-300 group-hover:bg-gradient-to-br group-hover:from-indigo-500 group-hover:to-cyan-400 group-hover:text-slate-950">
                <item.icon className="h-5 w-5" aria-hidden />
              </span>
              <h3 className="mt-5 text-[1.0625rem] font-semibold text-slate-950">{item.title}</h3>
              <p className="mt-2 text-[0.875rem] leading-6 text-slate-600">{item.copy}</p>
            </div>
          ))}
        </Stagger>
      </Container>
    </section>
  );
}

/* ========================================================================== */

function Capabilities() {
  return (
    <section className="relative overflow-hidden border-y border-slate-200 bg-slate-50 py-20 sm:py-28">
      <Container>
        <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-20">
          <div>
            <SectionHeading
              align="left"
              eyebrow="Priced on the server"
              title={<>A till can ask. It can never decide.</>}
              copy="Every price, discount and total is computed by the server from the catalogue. A tampered browser cannot change what a customer is charged, and stock cannot go negative behind your back."
              className="max-w-xl"
            />
            <Stagger className="mt-9 space-y-4" step={80}>
              {[
                ['Server-side pricing', 'The browser sends a product and a quantity. Nothing else.'],
                ['Guarded stock', 'Two tills cannot sell the same unit; the database decides.'],
                ['Immutable records', 'Invoices and ledger rows are written once, never edited.'],
              ].map(([title, copy]) => (
                <div key={title} className="flex gap-4">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-white">
                    <Lock className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <div>
                    <p className="text-[0.9375rem] font-semibold text-slate-950">{title}</p>
                    <p className="mt-1 text-[0.875rem] leading-6 text-slate-600">{copy}</p>
                  </div>
                </div>
              ))}
            </Stagger>
          </div>

          <Reveal from="left" delay={120}>
            <PricingFlow />
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

/** A small diagram of how a sale is priced: request in, decision on the server. */
function PricingFlow() {
  return (
    <div className="rs-ring overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white p-7 shadow-[0_30px_80px_-50px_rgba(15,23,42,0.5)]">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">One sale</p>

      <div className="mt-6 space-y-3">
        <FlowRow tone="muted" label="Till sends" value="productId × 2" />
        <div className="flex justify-center py-1">
          <span className="h-6 w-px bg-gradient-to-b from-slate-300 to-indigo-400" />
        </div>
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4">
          <p className="flex items-center gap-2 text-[0.8125rem] font-semibold text-indigo-900">
            <Store className="h-3.5 w-3.5" aria-hidden />
            Server prices it
          </p>
          <ul className="mt-3 space-y-1.5 font-mono text-[11px] text-indigo-900/70">
            <li>catalogue price × quantity</li>
            <li>− discount the role allows</li>
            <li>+ VAT when the branch charges it</li>
            <li>− stock, guarded</li>
          </ul>
        </div>
        <div className="flex justify-center py-1">
          <span className="h-6 w-px bg-gradient-to-b from-indigo-400 to-emerald-400" />
        </div>
        <FlowRow tone="good" label="Recorded" value="immutable sale" />
      </div>
    </div>
  );
}

function FlowRow({ label, value, tone }: { label: string; value: string; tone: 'muted' | 'good' }) {
  return (
    <div
      className={cn(
        'flex items-center justify-between rounded-xl border px-4 py-3',
        tone === 'good' ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200 bg-slate-50',
      )}
    >
      <span className={cn('text-[0.8125rem] font-medium', tone === 'good' ? 'text-emerald-900' : 'text-slate-600')}>{label}</span>
      <span className={cn('font-mono text-[12px]', tone === 'good' ? 'text-emerald-700' : 'text-slate-500')}>{value}</span>
    </div>
  );
}

/* ========================================================================== */

function HowItWorks() {
  const steps = [
    { icon: Store, title: 'Create a workspace', copy: 'Pick the POS type. The right catalogue and till come with it.' },
    { icon: Boxes, title: 'Load the catalogue', copy: 'Add products by hand, or import a spreadsheet.' },
    { icon: Wallet, title: 'Start selling', copy: 'Open a shift, scan, take the money, print the receipt.' },
  ];

  return (
    <section className="bg-white py-20 sm:py-28">
      <Container>
        <SectionHeading eyebrow="How it works" title={<>Trading on day one.</>} />

        <div className="relative mt-14">
          {/* the rail the steps sit on */}
          <div
            aria-hidden
            className="absolute left-0 right-0 top-[2.1rem] hidden h-px bg-gradient-to-r from-transparent via-slate-300 to-transparent lg:block"
          />
          <Stagger className="grid gap-10 lg:grid-cols-3 lg:gap-8" step={120}>
            {steps.map((step, index) => (
              <div key={step.title} className="relative text-center lg:px-6">
                <span className="relative z-10 mx-auto flex h-[4.25rem] w-[4.25rem] items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-[0_16px_40px_-24px_rgba(15,23,42,0.5)]">
                  <step.icon className="h-6 w-6 text-slate-950" aria-hidden />
                  <span className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-cyan-400 text-[11px] font-bold text-slate-950">
                    {index + 1}
                  </span>
                </span>
                <h3 className="mt-6 text-[1.0625rem] font-semibold text-slate-950">{step.title}</h3>
                <p className="mx-auto mt-2 max-w-xs text-[0.875rem] leading-6 text-slate-600">{step.copy}</p>
              </div>
            ))}
          </Stagger>
        </div>
      </Container>
    </section>
  );
}

/* ========================================================================== */

/** Shape only — a picture of a reporting page, not a claim about your numbers. */
const TREND = [38, 52, 44, 67, 58, 79, 71, 92];

function Growth() {
  return (
    <DarkSection className="py-20 sm:py-28">
      <Container>
        <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.1fr] lg:gap-20">
          <div>
            <SectionHeading
              tone="dark"
              align="left"
              eyebrow="Analytics"
              title={<>Know what you kept.</>}
              copy="Not just what you charged. Cost is captured at the moment of sale, so margin is a fact rather than an estimate — per product, per branch, per cashier."
              className="max-w-xl"
            />
            <Stagger className="mt-10 grid grid-cols-3 gap-6 border-t border-white/10 pt-8" step={90}>
              {[
                { to: 30, suffix: ' days', label: 'Branch overview' },
                { to: 4, suffix: '', label: 'POS types reported' },
                { to: 1, suffix: '', label: 'Account, every shop' },
              ].map((stat) => (
                <div key={stat.label}>
                  <p className="text-2xl font-bold text-white sm:text-[1.75rem]">
                    <Counter to={stat.to} suffix={stat.suffix} />
                  </p>
                  <p className="mt-1.5 text-[0.8125rem] leading-5 text-slate-500">{stat.label}</p>
                </div>
              ))}
            </Stagger>
          </div>

          <Reveal from="left" delay={120}>
            <AnalyticsPanel />
          </Reveal>
        </div>
      </Container>
    </DarkSection>
  );
}

function AnalyticsPanel() {
  return (
    <div className="rs-ring rs-glass overflow-hidden rounded-[1.5rem] p-7 shadow-[0_40px_100px_-50px_rgba(2,6,23,0.9)]">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">Net sales</p>
          <p className="mt-2 font-mono text-3xl font-bold text-white">
            ৳ <Counter to={482650} />
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 ring-1 ring-emerald-400/20">
          <BarChart3 className="h-3 w-3" aria-hidden />
          Gross − refunds
        </span>
      </div>

      <div className="mt-9 flex h-40 items-end gap-2.5" role="img" aria-label="Eight periods of sales, trending upward">
        {TREND.map((height, index) => (
          <span
            key={index}
            className="rs-bar flex-1 rounded-t-md bg-gradient-to-t from-indigo-500/35 to-cyan-300/80"
            style={{ height: `${height}%`, animationDelay: `${index * 85}ms` }}
          />
        ))}
      </div>

      <div className="mt-7 grid grid-cols-3 gap-3 border-t border-white/10 pt-6">
        {[
          ['Gross', '৳ 511,400'],
          ['Refunds', '৳ 28,750'],
          ['Margin', '31.4%'],
        ].map(([label, value]) => (
          <div key={label}>
            <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
            <p className="mt-1 font-mono text-[0.9375rem] font-semibold text-white">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ========================================================================== */

function Trust() {
  const pillars = [
    { icon: Lock, title: 'Tenant isolation', copy: 'A workspace can only ever read its own data. The server decides, not the request.' },
    { icon: Fingerprint, title: 'Roles and permissions', copy: 'Who may discount, refund or see cost is set per role and checked on every call.' },
    { icon: Receipt, title: 'Immutable money', copy: 'Invoices, receipts and ledger rows are written once. Corrections are new rows.' },
    { icon: RefreshCw, title: 'Safe by default', copy: 'Payments are idempotent and stock is guarded, so a retry never charges twice.' },
  ];

  return (
    <section className="border-y border-slate-200 bg-slate-50 py-20 sm:py-28">
      <Container>
        <SectionHeading
          eyebrow="Built to be trusted"
          title={<>Money deserves a careful system.</>}
          copy="The parts that handle cash are the parts we hardened first."
        />
        <Stagger className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" step={70}>
          {pillars.map((pillar) => (
            <div key={pillar.title} className="rs-lift h-full rounded-2xl border border-slate-200 bg-white p-6">
              <pillar.icon className="h-5 w-5 text-indigo-600" aria-hidden />
              <h3 className="mt-5 text-[1rem] font-semibold text-slate-950">{pillar.title}</h3>
              <p className="mt-2 text-[0.875rem] leading-6 text-slate-600">{pillar.copy}</p>
            </div>
          ))}
        </Stagger>
      </Container>
    </section>
  );
}

/* ========================================================================== */

function FinalCta() {
  return (
    <DarkSection grid className="py-24 sm:py-32">
      <Container>
        <div className="mx-auto max-w-3xl text-center">
          <Reveal>
            <Eyebrow>
              <Sparkles className="h-3 w-3" aria-hidden />
              Free to start
            </Eyebrow>
          </Reveal>
          <Reveal delay={80}>
            <h2 className="rs-display mt-7 text-pretty text-[2.5rem] font-bold text-white sm:text-[3.5rem]">
              Open your first <span className="rs-gradient-text">counter</span> today.
            </h2>
          </Reveal>
          <Reveal delay={150}>
            <p className="mx-auto mt-6 max-w-xl text-[1.0625rem] leading-8 text-slate-400">
              Create a workspace, pick your POS type and start selling. No card needed to try it.
            </p>
          </Reveal>
          <Reveal delay={220}>
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <CtaButton to="/register">Create a workspace</CtaButton>
              <CtaButton to="/pricing" variant="ghost">
                See pricing
              </CtaButton>
            </div>
          </Reveal>
        </div>
      </Container>
    </DarkSection>
  );
}
