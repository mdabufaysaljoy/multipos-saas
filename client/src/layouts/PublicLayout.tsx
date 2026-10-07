import * as React from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/features/public/BrandMark';
import { Container } from '@/features/public/primitives';
import { useAuth } from '@/hooks/useAuth';
import { telHref, useSite } from '@/features/public/useSite';
import { cn } from '@/lib/utils';
import { PageFallback } from '@/lib/lazyPage';

const NAV = [
  { to: '/products', label: 'POS systems' },
  { to: '/features', label: 'Platform' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/contact', label: 'Company' },
];

export function PublicLayout() {
  const { session } = useAuth();
  const site = useSite();
  const location = useLocation();
  const [open, setOpen] = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);
  const destination = session?.user.role === 'platform_admin' ? '/platform' : '/pos';

  React.useEffect(() => setOpen(false), [location.pathname]);

  // The bar is transparent over the hero and becomes solid once the page
  // moves, so the first screen reads as one piece.
  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // An open menu should not leave the page scrolling underneath it.
  React.useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <div className="public-shell flex min-h-full flex-col bg-[#050915] text-white">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-950"
      >
        Skip to content
      </a>

      <header
        className={cn(
          'sticky top-0 z-50 transition-all duration-500',
          scrolled ? 'border-b border-white/10 bg-[#050915]/85 backdrop-blur-xl' : 'border-b border-transparent',
        )}
      >
        <Container className="flex h-[4.5rem] items-center gap-8">
          <BrandMark />

          <nav className="hidden flex-1 items-center gap-1 lg:flex" aria-label="Primary">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'relative rounded-full px-3.5 py-2 text-sm font-medium transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400',
                    isActive ? 'text-white' : 'text-slate-400 hover:text-white',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {item.label}
                    <span
                      aria-hidden
                      className={cn(
                        'absolute inset-x-3.5 -bottom-px h-px origin-left bg-gradient-to-r from-indigo-400 to-cyan-300 transition-transform duration-300',
                        isActive ? 'scale-x-100' : 'scale-x-0',
                      )}
                    />
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto hidden items-center gap-2 lg:flex">
            {session ? (
              <Button asChild className="rounded-full bg-white px-5 font-semibold text-slate-950 hover:bg-slate-100">
                <Link to={destination}>
                  Open dashboard <ArrowUpRight />
                </Link>
              </Button>
            ) : (
              <>
                <Button asChild variant="ghost" className="rounded-full text-slate-300 hover:bg-white/10 hover:text-white">
                  <Link to="/login">Sign in</Link>
                </Button>
                <Button
                  asChild
                  className="rounded-full bg-gradient-to-r from-indigo-500 to-cyan-400 px-5 font-semibold text-slate-950 shadow-[0_12px_32px_-12px_rgba(79,70,229,0.9)] transition hover:brightness-110"
                >
                  <Link to="/register">Start free</Link>
                </Button>
              </>
            )}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="ml-auto rounded-full text-white hover:bg-white/10 lg:hidden"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="public-mobile-nav"
          >
            {open ? <X /> : <Menu />}
          </Button>
        </Container>

        {open && (
          <div id="public-mobile-nav" className="border-t border-white/10 bg-[#050915] lg:hidden">
            <Container className="py-5">
              <nav className="space-y-1" aria-label="Mobile">
                {NAV.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'block rounded-xl px-4 py-3 text-[0.95rem] font-medium transition',
                        isActive ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-white',
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </nav>
              <div className="mt-5 grid gap-2">
                {session ? (
                  <Button asChild className="h-12 rounded-xl bg-white font-semibold text-slate-950">
                    <Link to={destination}>Open dashboard</Link>
                  </Button>
                ) : (
                  <>
                    <Button asChild className="h-12 rounded-xl bg-gradient-to-r from-indigo-500 to-cyan-400 font-semibold text-slate-950">
                      <Link to="/register">Start free</Link>
                    </Button>
                    <Button asChild variant="ghost" className="h-12 rounded-xl text-slate-300 ring-1 ring-white/10">
                      <Link to="/login">Sign in</Link>
                    </Button>
                  </>
                )}
              </div>
            </Container>
          </div>
        )}
      </header>

      <main id="main" className="flex-1">
        <React.Suspense fallback={<PageFallback />}>
          <Outlet />
        </React.Suspense>
      </main>

      <footer className="relative isolate overflow-hidden border-t border-white/10 bg-[#050915]">
        <div aria-hidden className="rs-aurora opacity-40" />
        <Container className="relative py-16 lg:py-20">
          <div className="grid gap-12 lg:grid-cols-[1.6fr_1fr_1fr_1fr]">
            <div className="max-w-sm">
              <BrandMark />
              <p className="mt-5 text-[0.9375rem] leading-7 text-slate-400">
                {site?.tagline?.trim() ||
                  'One account. Every counter. Point of sale, stock and insight for clothing, restaurant, super shop and pharmacy businesses.'}
              </p>

              {/* Contact details the platform admin maintains. Each line is
                  omitted entirely when it is not set, so a half-filled address
                  never renders as a row of stray commas. */}
              <address className="mt-6 space-y-1.5 not-italic text-[0.875rem] leading-6 text-slate-400">
                {site?.contact.email && (
                  <a href={`mailto:${site.contact.email}`} className="block transition-colors hover:text-white">
                    {site.contact.email}
                  </a>
                )}
                {site?.contact.phone && (
                  <a href={telHref(site.contact.phone)} className="block transition-colors hover:text-white">
                    {site.contact.phone}
                  </a>
                )}
                {addressLines(site).length > 0 && (
                  <span className="block pt-1 text-slate-500">{addressLines(site).join(', ')}</span>
                )}
              </address>

              <SocialLinks site={site} />
            </div>
            <FooterCol
              title="POS systems"
              links={[
                ['Clothing', '/products/clothing-pos'],
                ['Restaurant', '/products/restaurant-pos'],
                ['Super Shop', '/products/super-shop-pos'],
                ['Pharmacy', '/products/pharmacy-pos'],
              ]}
            />
            <FooterCol
              title="Platform"
              links={[
                ['All capabilities', '/features'],
                ['Pricing', '/pricing'],
                ['Contact', '/contact'],
              ]}
            />
            <FooterCol
              title="Company"
              links={[
                ['Sign in', '/login'],
                ['Create workspace', '/register'],
                ['FAQ', '/faq'],
                ['Privacy policy', '/privacy'],
                ['Terms', '/terms'],
              ]}
            />
          </div>

          <div className="mt-14 flex flex-col gap-3 border-t border-white/10 pt-7 text-[0.8125rem] text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <p>
              © {new Date().getFullYear()} {site?.name?.trim() || 'Retailer Suites'}. All rights reserved.
            </p>
            <p>Built for growing businesses in Bangladesh and beyond.</p>
          </div>
        </Container>
      </footer>
    </div>
  );
}

/** The address as a list of the parts that were actually filled in. */
function addressLines(site: ReturnType<typeof useSite>): string[] {
  if (!site) return [];
  const { addressLine1, addressLine2, city, postcode, country } = site.contact;
  return [addressLine1, addressLine2, [city, postcode].filter(Boolean).join(' '), country]
    .map((part) => part?.trim() ?? '')
    .filter(Boolean);
}

/**
 * The brand's own profiles.
 *
 * `rel="me"` is not decoration: it is how a search engine confirms that these
 * accounts and this site are the same organisation, which is what lets the
 * brand panel in search results show them.
 */
function SocialLinks({ site }: { site: ReturnType<typeof useSite> }) {
  const links = [
    ['Facebook', site?.social.facebook],
    ['Instagram', site?.social.instagram],
    ['LinkedIn', site?.social.linkedin],
    ['YouTube', site?.social.youtube],
    ['X', site?.social.x],
  ].filter(([, href]) => Boolean(href)) as [string, string][];
  if (links.length === 0) return null;

  return (
    <ul className="mt-6 flex flex-wrap gap-x-4 gap-y-2">
      {links.map(([label, href]) => (
        <li key={label}>
          <a
            href={href}
            target="_blank"
            rel="me noopener noreferrer"
            className="text-[0.8125rem] text-slate-400 underline-offset-4 transition-colors hover:text-white hover:underline"
          >
            {label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <p className="mb-5 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">{title}</p>
      <ul className="space-y-3.5">
        {links.map(([label, to]) => (
          <li key={label}>
            <Link
              to={to}
              className="rounded text-[0.9375rem] text-slate-400 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
