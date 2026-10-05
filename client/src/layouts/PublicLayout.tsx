import * as React from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/features/public/BrandMark';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { PageFallback } from '@/lib/lazyPage';

const NAV = [
  { to: '/', label: 'Home', end: true },
  { to: '/products', label: 'Solutions' },
  { to: '/features', label: 'Platform' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/contact', label: 'Company' },
];

export function PublicLayout() {
  const { session } = useAuth();
  const location = useLocation();
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => setOpen(false), [location.pathname]);
  const destination = session?.user.role === 'platform_admin' ? '/platform' : '/pos';

  return (
    <div className="public-shell flex min-h-full flex-col bg-white text-slate-950">
      <header className="sticky top-0 z-50 border-b border-slate-200/70 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-[4.5rem] max-w-7xl items-center gap-7 px-4 sm:px-6 lg:px-8">
          <BrandMark />
          <nav className="hidden flex-1 items-center justify-center gap-1 lg:flex" aria-label="Primary navigation">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-full px-3.5 py-2 text-sm font-medium transition',
                    isActive
                      ? 'bg-slate-950 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto hidden items-center gap-2 lg:flex">
            {session ? (
              <Button className="rounded-full px-5" asChild>
                <Link to={destination}>
                  Open dashboard <ArrowUpRight />
                </Link>
              </Button>
            ) : (
              <>
                <Button variant="ghost" className="rounded-full" asChild>
                  <Link to="/login">Sign in</Link>
                </Button>
                <Button className="rounded-full px-5 shadow-lg shadow-primary/15" asChild>
                  <Link to="/register">
                    Start free <ArrowUpRight />
                  </Link>
                </Button>
              </>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto rounded-full lg:hidden"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="mobile-public-navigation"
          >
            {open ? <X /> : <Menu />}
          </Button>
        </div>
        {open && (
          <div id="mobile-public-navigation" className="animate-in slide-in-from-top-2 duration-200 lg:hidden">
            <div>
              <nav className="border-t border-slate-200/70 bg-white px-4 py-4 shadow-xl" aria-label="Mobile navigation">
                <div className="space-y-1">
                  {NAV.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) =>
                        cn(
                          'block rounded-xl px-4 py-3 text-sm font-medium',
                          isActive ? 'bg-slate-950 text-white' : 'text-slate-600 hover:bg-slate-100',
                        )
                      }
                    >
                      {item.label}
                    </NavLink>
                  ))}
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  {session ? (
                    <Button className="col-span-2 rounded-xl" asChild>
                      <Link to={destination}>Open dashboard</Link>
                    </Button>
                  ) : (
                    <>
                      <Button variant="outline" className="rounded-xl" asChild>
                        <Link to="/login">Sign in</Link>
                      </Button>
                      <Button className="rounded-xl" asChild>
                        <Link to="/register">Start free</Link>
                      </Button>
                    </>
                  )}
                </div>
              </nav>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1">
        <React.Suspense fallback={<PageFallback />}>
          <Outlet />
        </React.Suspense>
      </main>

      <footer className="relative overflow-hidden border-t border-slate-800 bg-slate-950 text-white">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(59,130,246,.15),transparent_30%),radial-gradient(circle_at_90%_70%,rgba(139,92,246,.12),transparent_30%)]" />
        <div className="relative mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
            <div className="max-w-sm space-y-4">
              <BrandMark className="text-white" />
              <p className="text-sm leading-6 text-slate-400">
                Purpose-built point of sale, inventory and insight tools for modern businesses—connected in one calm
                workspace.
              </p>
              <p className="text-xs font-medium text-cyan-300">Made for growing businesses in Bangladesh and beyond.</p>
            </div>
            <FooterCol
              title="Solutions"
              links={[
                ['Clothing', '/products/clothing-pos'],
                ['Restaurant', '/products/restaurant-pos'],
                ['Super Shop', '/products/super-shop-pos'],
                ['Pharmacy', '/products/pharmacy-pos'],
              ]}
            />
            <FooterCol
              title="Explore"
              links={[
                ['All features', '/features'],
                ['Pricing', '/pricing'],
                ['Contact', '/contact'],
              ]}
            />
            <FooterCol
              title="Account"
              links={[
                ['Sign in', '/login'],
                ['Create workspace', '/register'],
              ]}
            />
          </div>
          <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-6 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <p>© {new Date().getFullYear()} RetailerSWs. All rights reserved.</p>
            <p>One account · Multiple businesses · Real-time control</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <p className="mb-4 text-xs font-bold uppercase tracking-[.18em] text-slate-500">{title}</p>
      <ul className="space-y-3">
        {links.map(([label, to]) => (
          <li key={label}>
            <Link to={to} className="text-sm text-slate-300 transition hover:text-cyan-300">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
