import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProductPreview } from '@/features/public/ProductPreview';
import { Reveal, SectionHeading } from '@/features/public/Reveal';
import { SAAS_PRODUCTS } from './products.data';

export function PublicProductsPage() {
  return (
    <div className="bg-white">
      <section className="relative overflow-hidden bg-slate-950 px-4 py-20 text-white sm:px-6 lg:px-8 lg:py-28">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(79,70,229,.3),transparent_35%),radial-gradient(circle_at_85%_70%,rgba(6,182,212,.18),transparent_35%)]" />
        <div className="relative mx-auto max-w-7xl">
          <p className="text-xs font-bold uppercase tracking-[.22em] text-cyan-300">RetailerSWs solutions</p>
          <h1 className="mt-5 max-w-4xl text-balance text-4xl font-bold tracking-[-.05em] sm:text-6xl">
            Specialist workflows.
            <br />
            One connected operating system.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">
            Each POS is shaped around the work at its counter, while accounts, billing, teams and business control stay
            beautifully connected.
          </p>
        </div>
      </section>
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <SectionHeading
          eyebrow="Choose your workflow"
          title="Designed around your business, not the other way around."
          copy="Explore the product that matches your day-to-day operation. Every plan and limit shown on its page is read from the live platform catalogue."
        />
        <div className="mt-16 space-y-20 lg:space-y-28">
          {SAAS_PRODUCTS.map((product, index) => (
            <Reveal key={product.slug}>
              <article className="grid gap-9 lg:grid-cols-2 lg:items-center">
                <div className={index % 2 ? 'lg:order-2' : ''}>
                  <div className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700">
                    <product.icon className="h-3.5 w-3.5 text-primary" />
                    {product.tagline}
                  </div>
                  <h2 className="mt-5 text-3xl font-bold tracking-[-.04em] text-slate-950 sm:text-4xl">
                    {product.name}
                  </h2>
                  <p className="mt-4 max-w-xl text-base leading-7 text-slate-600">{product.description}</p>
                  <ul className="mt-6 grid gap-3 sm:grid-cols-2">
                    {product.highlights.map((line) => (
                      <li key={line} className="flex items-start gap-2 text-sm leading-6 text-slate-700">
                        <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                          <Check className="h-2.5 w-2.5" />
                        </span>
                        {line}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-8 flex flex-wrap gap-3">
                    <Button className="rounded-xl" asChild>
                      <Link to={`/register?pos=${product.vertical}`}>
                        Start free <ArrowRight />
                      </Link>
                    </Button>
                    <Button variant="outline" className="rounded-xl" asChild>
                      <Link to={`/products/${product.slug}`}>Features and plans</Link>
                    </Button>
                  </div>
                </div>
                <div className={index % 2 ? 'lg:order-1' : ''}>
                  <div className="rounded-[2rem] bg-gradient-to-br from-slate-100 via-white to-indigo-50 p-4 shadow-sm sm:p-8">
                    <ProductPreview kind={product.vertical} />
                  </div>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
      <section className="px-4 pb-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl rounded-[2rem] bg-slate-100 p-8 text-center sm:p-12">
          <h2 className="text-3xl font-bold tracking-[-.04em]">Not sure which workflow fits?</h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-600">
            Tell us how your business sells and manages stock. We’ll help you find the closest fit.
          </p>
          <Button variant="outline" className="mt-6 rounded-xl bg-white" asChild>
            <Link to="/contact">
              Talk to us <ArrowRight />
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
