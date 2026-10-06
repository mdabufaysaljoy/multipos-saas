import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Reveal } from '@/features/public/motion';
import { Container, CtaButton, DarkSection, SectionHeading } from '@/features/public/primitives';
import { PosTerminal, type TerminalVertical } from '@/features/public/PosTerminal';
import { SAAS_PRODUCTS } from './products.data';

const ACCENT: Record<string, string> = {
  clothing: 'from-violet-500 to-fuchsia-500',
  restaurant: 'from-orange-500 to-rose-500',
  supershop: 'from-emerald-500 to-teal-500',
  pharmacy: 'from-cyan-500 to-blue-500',
};

/** Every POS the platform sells, each one registerable today. */
export function PublicProductsPage() {
  return (
    <>
      <DarkSection grid className="py-20 sm:py-28">
        <Container>
          <SectionHeading
            tone="dark"
            eyebrow="POS systems"
            title={<>Built for the way your trade sells.</>}
            copy="Four point-of-sale systems on one platform. Same account, same billing, same reports — a counter that fits each business."
          />
        </Container>
      </DarkSection>

      <section className="bg-white py-20 sm:py-24">
        <Container>
          <div className="space-y-24 lg:space-y-32">
            {SAAS_PRODUCTS.map((product, index) => {
              const flipped = index % 2 === 1;
              return (
                <div key={product.slug} className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
                  <Reveal from={flipped ? 'left' : 'right'} className={cn(flipped && 'lg:order-2')}>
                    <div>
                      <span
                        className={cn(
                          'inline-flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br text-white',
                          ACCENT[product.vertical],
                        )}
                      >
                        <product.icon className="h-5 w-5" aria-hidden />
                      </span>
                      <h2 className="rs-h2 mt-6 text-[1.75rem] font-bold text-slate-950 sm:text-[2.25rem]">{product.name}</h2>
                      <p className="mt-2 text-[0.9375rem] font-medium text-indigo-600">{product.tagline}</p>
                      <p className="mt-4 max-w-lg text-pretty text-[0.9375rem] leading-7 text-slate-600">{product.description}</p>

                      <ul className="mt-7 space-y-2.5">
                        {product.highlights.map((highlight) => (
                          <li key={highlight} className="flex items-start gap-2.5 text-[0.875rem] text-slate-700">
                            <span className={cn('mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-br', ACCENT[product.vertical])} />
                            {highlight}
                          </li>
                        ))}
                      </ul>

                      <Link
                        to={`/products/${product.slug}`}
                        className="group mt-8 inline-flex items-center gap-1.5 rounded text-[0.9375rem] font-semibold text-slate-950 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                      >
                        Everything in {product.name}
                        <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" aria-hidden />
                      </Link>
                    </div>
                  </Reveal>

                  <Reveal from={flipped ? 'right' : 'left'} delay={100} className={cn(flipped && 'lg:order-1')}>
                    {/* The till sits on a dark plate so the product art reads the
                        same here as it does in the hero. */}
                    <div className="rounded-[1.75rem] bg-[#050915] p-5 sm:p-7">
                      <PosTerminal vertical={product.vertical as TerminalVertical} />
                    </div>
                  </Reveal>
                </div>
              );
            })}
          </div>
        </Container>
      </section>

      <DarkSection className="py-20 sm:py-24">
        <Container>
          <div className="mx-auto max-w-2xl text-center">
            <Reveal>
              <h2 className="rs-h2 text-[2rem] font-bold text-white sm:text-[2.5rem]">Run more than one?</h2>
            </Reveal>
            <Reveal delay={80}>
              <p className="mt-5 text-[1.0625rem] leading-8 text-slate-400">
                Add a workspace for each business. One sign-in, one wallet, separate books.
              </p>
            </Reveal>
            <Reveal delay={150}>
              <div className="mt-9 flex flex-wrap justify-center gap-3">
                <CtaButton to="/register">Start free</CtaButton>
                <CtaButton to="/pricing" variant="ghost">
                  See pricing
                </CtaButton>
              </div>
            </Reveal>
          </div>
        </Container>
      </DarkSection>
    </>
  );
}
