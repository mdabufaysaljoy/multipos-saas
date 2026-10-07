import { Link } from 'react-router-dom';
import { ChevronDown, MessageCircleQuestion } from 'lucide-react';
import { Container, SectionHeading } from '@/features/public/primitives';
import { Markdown } from '@/features/public/Markdown';
import { Reveal } from '@/features/public/motion';
import { useSite } from '@/features/public/useSite';

/**
 * Questions people actually ask, written by the platform admin.
 *
 * Native `<details>` rather than a scripted accordion: it opens without
 * JavaScript, it is keyboard accessible for free, and - the reason that
 * matters here - the answers are in the DOM whether or not a panel is open, so
 * a crawler reads all of them. An accordion that mounts its answer on click
 * hides the content from exactly the audience this page is for.
 */
export function FaqPage() {
  const site = useSite();
  const faq = site?.content?.faq ?? [];

  return (
    <div className="bg-white">
      <section className="border-b border-slate-200 bg-slate-50 py-16 sm:py-20">
        <Container>
          <SectionHeading
            eyebrow="Answers"
            title="Frequently asked questions"
            copy="If something is not here, ask us — we answer every message."
          />
        </Container>
      </section>

      <section className="py-14 sm:py-20">
        <Container>
          <div className="mx-auto max-w-3xl">
            {faq.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
                <MessageCircleQuestion className="mx-auto h-8 w-8 text-slate-400" aria-hidden />
                <p className="mt-4 font-medium text-slate-900">No questions published yet.</p>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
                  Ask us anything about the POS, pricing or getting your shop set up.
                </p>
                <Link
                  to="/contact"
                  className="mt-6 inline-flex rounded-full border border-slate-300 px-5 py-2 text-sm font-medium text-slate-900 transition hover:border-slate-400 hover:bg-white"
                >
                  Contact us
                </Link>
              </div>
            ) : (
              <div className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200">
                {faq.map((entry, index) => (
                  <Reveal key={index} delay={index * 40}>
                    <details className="group bg-white open:bg-slate-50/60">
                      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-5 py-4 text-left font-medium text-slate-900 outline-none transition hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-indigo-400">
                        <span>{entry.question}</span>
                        <ChevronDown
                          className="mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform duration-300 group-open:rotate-180"
                          aria-hidden
                        />
                      </summary>
                      <div className="px-5 pb-5 pt-0">
                        <Markdown source={entry.answer} className="text-[0.9375rem] [&>*:last-child]:mb-0" />
                      </div>
                    </details>
                  </Reveal>
                ))}
              </div>
            )}
          </div>
        </Container>
      </section>
    </div>
  );
}
