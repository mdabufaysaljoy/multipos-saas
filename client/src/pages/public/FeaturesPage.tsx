import { Link } from 'react-router-dom';
import { ArrowRight, BarChart3, Building2, Layers, Receipt, Users, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AnalyticsPreview } from '@/features/public/ProductPreview';
import { Reveal, SectionHeading } from '@/features/public/Reveal';
import { SAAS_PRODUCTS } from './products.data';

const FEATURES = [
  [
    Layers,
    'Several POS. One account.',
    'Run different business types from one identity while every workspace keeps its own stock, team and subscription.',
  ],
  [
    Wallet,
    'One wallet for everything',
    'Fund once, pay for workspaces and services, and keep a transparent record of every movement.',
  ],
  [
    BarChart3,
    'Insight that stays useful',
    'Move from daily sales to profit, product, customer and staff analysis as your plan grows.',
  ],
  [
    Building2,
    'Branches without blind spots',
    'Separate operational data by branch, then bring it together for owners who need the complete picture.',
  ],
  [
    Users,
    'Access with intention',
    'Give each staff member the permissions their role needs, protected beyond the interface.',
  ],
  [
    Receipt,
    'A clean paper trail',
    'Print receipts at the counter and keep subscription invoices ready when the business needs them.',
  ],
] as const;

export function FeaturesPage() {
  return (
    <div className="bg-white">
      <section className="px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <Reveal>
          <SectionHeading
            eyebrow="The platform underneath"
            title="Powerful where it matters. Quiet everywhere else."
            copy="RetailerSWs connects the work at the counter to the control behind it—without forcing every business into the same workflow."
          />
        </Reveal>
        <div className="mx-auto mt-14 grid max-w-7xl gap-px overflow-hidden rounded-[2rem] bg-slate-200 ring-1 ring-slate-200 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([Icon, title, copy], index) => (
            <Reveal key={title} delay={(index % 3) * 60} className="bg-white">
              <article className="h-full p-7 lg:p-8">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-950 text-cyan-300">
                  <Icon className="h-5 w-5" />
                </span>
                <h2 className="mt-6 text-lg font-bold">{title}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">{copy}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </section>
      <section className="bg-slate-950 px-4 py-20 text-white sm:px-6 lg:px-8 lg:py-28">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[.82fr_1.18fr] lg:items-center">
          <Reveal>
            <p className="text-xs font-bold uppercase tracking-[.22em] text-cyan-300">See what changed today</p>
            <h2 className="mt-4 text-balance text-4xl font-bold tracking-[-.045em]">
              Decisions move faster when the picture is clear.
            </h2>
            <p className="mt-5 text-lg leading-8 text-slate-400">
              Sales, inventory, payments and profitability belong in the same conversation. Your available analytics
              follow the plan catalogue already enforced by the platform.
            </p>
            <Button
              variant="outline"
              className="mt-8 rounded-xl border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
              asChild
            >
              <Link to="/pricing">
                Compare plans <ArrowRight />
              </Link>
            </Button>
          </Reveal>
          <Reveal delay={120}>
            <AnalyticsPreview />
          </Reveal>
        </div>
      </section>
      <section className="px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <SectionHeading
          eyebrow="Trade-specific depth"
          title="Shared foundations. Specialist detail."
          copy="The platform remains consistent while each POS adds the tools its business type genuinely needs."
        />
        <div className="mx-auto mt-12 grid max-w-7xl gap-4 sm:grid-cols-2">
          {SAAS_PRODUCTS.map((product) => (
            <Link
              key={product.slug}
              to={`/products/${product.slug}`}
              className="group flex gap-5 rounded-2xl border border-slate-200 p-6 transition hover:-translate-y-1 hover:border-indigo-200 hover:shadow-xl hover:shadow-slate-900/5"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700 transition group-hover:bg-slate-950 group-hover:text-cyan-300">
                <product.icon className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2 font-bold">
                  {product.name}
                  <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                </span>
                <span className="mt-1 block text-sm text-slate-500">{product.tagline}</span>
                <span className="mt-3 line-clamp-2 block text-sm leading-6 text-slate-600">{product.description}</span>
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
