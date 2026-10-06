import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Mail, MessageCircle, Phone } from 'lucide-react';
import { get } from '@/api/client';
import { Reveal, Stagger } from '@/features/public/motion';
import { Container, CtaButton, DarkSection, SectionHeading } from '@/features/public/primitives';

/**
 * Contact.
 *
 * The email and phone come from the platform's own public settings, so support
 * details change in one place rather than being hard-coded into the website.
 */
export function ContactPage() {
  const { data } = useQuery({
    queryKey: ['public', 'contact'],
    queryFn: () => get<{ supportEmail: string; supportPhone: string }>('/public/contact'),
    retry: false,
  });

  const channels = [
    data?.supportEmail && {
      icon: Mail,
      label: 'Email us',
      value: data.supportEmail,
      href: `mailto:${data.supportEmail}`,
      copy: 'Best for questions about plans, limits or moving an existing catalogue.',
    },
    data?.supportPhone && {
      icon: Phone,
      label: 'Call us',
      value: data.supportPhone,
      href: `tel:${data.supportPhone.replace(/\s+/g, '')}`,
      copy: 'Best when a counter is waiting and you need an answer now.',
    },
  ].filter(Boolean) as { icon: typeof Mail; label: string; value: string; href: string; copy: string }[];

  return (
    <>
      <DarkSection grid className="py-20 sm:py-28">
        <Container>
          <SectionHeading
            tone="dark"
            eyebrow="Company"
            title={<>Let's find the right setup.</>}
            copy="Tell us what you sell, how many counters you run and what slows the team down. We will tell you honestly whether Retailer Suites fits."
          />
        </Container>
      </DarkSection>

      <section className="bg-white py-20 sm:py-24">
        <Container>
          {channels.length > 0 ? (
            <Stagger className="grid gap-5 sm:grid-cols-2" step={100}>
              {channels.map((channel) => (
                <a
                  key={channel.label}
                  href={channel.href}
                  className="rs-lift group block rounded-[1.4rem] border border-slate-200 bg-white p-8 outline-none hover:border-indigo-200 focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-950 text-white transition-colors duration-300 group-hover:bg-gradient-to-br group-hover:from-indigo-500 group-hover:to-cyan-400 group-hover:text-slate-950">
                    <channel.icon className="h-5 w-5" aria-hidden />
                  </span>
                  <p className="mt-6 text-[0.8125rem] font-semibold uppercase tracking-[0.14em] text-slate-400">
                    {channel.label}
                  </p>
                  <p className="mt-2 flex items-center gap-1.5 text-[1.125rem] font-semibold text-slate-950">
                    {channel.value}
                    <ArrowUpRight
                      className="h-4 w-4 text-slate-400 transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                      aria-hidden
                    />
                  </p>
                  <p className="mt-3 text-[0.875rem] leading-6 text-slate-600">{channel.copy}</p>
                </a>
              ))}
            </Stagger>
          ) : (
            <Reveal>
              <div className="rounded-[1.4rem] border border-slate-200 bg-slate-50 p-10 text-center">
                <MessageCircle className="mx-auto h-6 w-6 text-slate-400" aria-hidden />
                <p className="mt-4 text-[0.9375rem] text-slate-600">
                  Support channels are being set up. In the meantime, create a workspace and try the platform free.
                </p>
              </div>
            </Reveal>
          )}

          <Reveal delay={160}>
            <div className="mt-16 rounded-[1.4rem] border border-slate-200 bg-slate-50 p-10 text-center sm:p-14">
              <h2 className="rs-h2 text-[1.75rem] font-bold text-slate-950 sm:text-[2.25rem]">
                Or just try it.
              </h2>
              <p className="mx-auto mt-4 max-w-lg text-[0.9375rem] leading-7 text-slate-600">
                A workspace takes a minute to create, and you can see the whole platform before you pay for anything.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <CtaButton to="/register">Start free</CtaButton>
                <CtaButton to="/pricing" variant="light" className="ring-1 ring-slate-200">
                  See pricing
                </CtaButton>
              </div>
            </div>
          </Reveal>
        </Container>
      </section>
    </>
  );
}
