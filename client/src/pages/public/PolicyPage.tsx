import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { Container, SectionHeading } from '@/features/public/primitives';
import { Markdown } from '@/features/public/Markdown';
import { useSite } from '@/features/public/useSite';

/**
 * The policy pages: privacy, terms, refunds.
 *
 * One component for all three because they are the same page with different
 * text, and that text is written by the platform admin rather than living in
 * the build. A page whose text has not been written yet says so plainly
 * instead of publishing an empty document - an empty privacy policy is worse
 * than an honest "not published yet", because a visitor cannot tell the
 * difference between "we collect nothing" and "nobody wrote this".
 */
export function PolicyPage({ kind }: { kind: 'privacyPolicy' | 'terms' | 'refundPolicy' }) {
  const site = useSite();
  const body = site?.content?.[kind] ?? '';

  const title =
    kind === 'privacyPolicy' ? 'Privacy policy' : kind === 'terms' ? 'Terms of service' : 'Refund policy';
  const copy =
    kind === 'privacyPolicy'
      ? 'What we collect, why we collect it, and what we do with it.'
      : kind === 'terms'
        ? 'The agreement between your business and ours.'
        : 'When a payment can be refunded, and how.';

  return (
    <div className="bg-white">
      <section className="border-b border-slate-200 bg-slate-50 py-16 sm:py-20">
        <Container>
          <SectionHeading eyebrow="Legal" title={title} copy={copy} />
        </Container>
      </section>

      <section className="py-14 sm:py-20">
        <Container>
          <div className="mx-auto max-w-3xl">
            {body.trim() === '' ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
                <FileText className="mx-auto h-8 w-8 text-slate-400" aria-hidden />
                <p className="mt-4 font-medium text-slate-900">This page has not been published yet.</p>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
                  If you need this document before it is online, {site?.contact?.email ? 'email us and we will send it to you.' : 'get in touch and we will send it to you.'}
                </p>
                <Link
                  to="/contact"
                  className="mt-6 inline-flex rounded-full border border-slate-300 px-5 py-2 text-sm font-medium text-slate-900 transition hover:border-slate-400 hover:bg-white"
                >
                  Contact us
                </Link>
              </div>
            ) : (
              <Markdown source={body} className="text-[0.9375rem]" />
            )}
          </div>
        </Container>
      </section>
    </div>
  );
}

export function PrivacyPage() {
  return <PolicyPage kind="privacyPolicy" />;
}
export function TermsPage() {
  return <PolicyPage kind="terms" />;
}
export function RefundPage() {
  return <PolicyPage kind="refundPolicy" />;
}
