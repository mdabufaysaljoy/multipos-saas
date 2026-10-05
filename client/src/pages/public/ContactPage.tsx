import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Mail, MessageCircle, Phone, Store } from 'lucide-react';
import { get } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Reveal } from '@/features/public/Reveal';

export function ContactPage() {
  const { data } = useQuery({
    queryKey: ['public', 'contact'],
    queryFn: () => get<{ supportEmail: string; supportPhone: string }>('/public/contact'),
    retry: false,
  });
  return (
    <div className="bg-white">
      <section className="relative overflow-hidden bg-slate-950 px-4 py-20 text-white sm:px-6 lg:px-8 lg:py-28">
        <div className="absolute right-0 top-0 h-96 w-96 rounded-full bg-indigo-500/20 blur-3xl" />
        <div className="relative mx-auto max-w-7xl">
          <p className="text-xs font-bold uppercase tracking-[.22em] text-cyan-300">Real help, when it matters</p>
          <h1 className="mt-5 max-w-3xl text-balance text-4xl font-bold tracking-[-.05em] sm:text-6xl">
            Let’s find the right setup for your business.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">
            Questions about a plan, moving your operation or choosing the right POS? Start with the channel that works
            for you.
          </p>
        </div>
      </section>
      <section className="px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[.85fr_1.15fr]">
          <Reveal>
            <div className="rounded-[2rem] bg-gradient-to-br from-indigo-50 to-cyan-50 p-8 sm:p-10">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-950 text-cyan-300">
                <MessageCircle className="h-5 w-5" />
              </span>
              <h2 className="mt-7 text-3xl font-bold tracking-[-.04em]">A conversation, not a sales script.</h2>
              <p className="mt-4 leading-7 text-slate-600">
                Tell us what you sell, how many locations you run and what slows the team down today. We’ll help you
                understand where RetailerSWs fits.
              </p>
              <div className="mt-8 flex items-center gap-3 text-sm font-medium text-slate-700">
                <Store className="h-4 w-4 text-indigo-600" /> Clothing · Restaurant · Super Shop · Pharmacy
              </div>
            </div>
          </Reveal>
          <div className="grid gap-4 sm:grid-cols-2">
            <ContactCard
              icon={Mail}
              label="Email support"
              value={data?.supportEmail || 'Support email is being configured'}
              href={data?.supportEmail ? `mailto:${data.supportEmail}` : undefined}
            />
            <ContactCard
              icon={Phone}
              label="Call support"
              value={data?.supportPhone || 'Support phone is being configured'}
              href={data?.supportPhone ? `tel:${data.supportPhone}` : undefined}
            />
            <div className="rounded-2xl border border-slate-200 p-7 sm:col-span-2">
              <p className="text-xs font-bold uppercase tracking-[.18em] text-slate-400">
                Ready to explore on your own?
              </p>
              <h3 className="mt-3 text-xl font-bold">See exactly what each solution includes.</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Product pages use the live plan catalogue, so prices and available limits stay aligned with the
                platform.
              </p>
              <Button className="mt-6 rounded-xl" asChild>
                <Link to="/products">
                  Explore solutions <ArrowRight />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function ContactCard({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: typeof Mail;
  label: string;
  value: string;
  href?: string;
}) {
  const content = (
    <>
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-indigo-600">
        <Icon className="h-5 w-5" />
      </span>
      <p className="mt-6 text-xs font-bold uppercase tracking-[.16em] text-slate-400">{label}</p>
      <p className="mt-2 break-words font-semibold text-slate-900">{value}</p>
      {href && (
        <span className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-indigo-600">
          Contact now <ArrowRight className="h-4 w-4" />
        </span>
      )}
    </>
  );
  return href ? (
    <a
      href={href}
      className="rounded-2xl border border-slate-200 p-7 transition hover:-translate-y-1 hover:shadow-xl hover:shadow-slate-900/5"
    >
      {content}
    </a>
  ) : (
    <div className="rounded-2xl border border-slate-200 p-7">{content}</div>
  );
}
