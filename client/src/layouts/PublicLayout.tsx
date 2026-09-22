import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import * as React from 'react';
import { Menu, Store, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { PageFallback } from '@/lib/lazyPage';

const NAV = [
  { to: '/', label: 'Home', end: true },
  { to: '/products', label: 'Products' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/features', label: 'Features' },
  { to: '/contact', label: 'Contact' },
];

/** Marketing shell. Kept entirely separate from the signed-in app chrome. */
export function PublicLayout() {
  const { session } = useAuth();
  const location = useLocation();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 lg:px-6">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Store className="h-4 w-4" />
            </span>
            RetailSuite
          </Link>

          <nav className="hidden flex-1 items-center gap-1 md:flex">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto hidden items-center gap-2 md:flex">
            {session ? (
              <Button asChild>
                <Link to={session.user.role === 'platform_admin' ? '/platform' : '/pos'}>Open dashboard</Link>
              </Button>
            ) : (
              <>
                <Button variant="ghost" asChild>
                  <Link to="/login">Sign in</Link>
                </Button>
                <Button asChild>
                  <Link to="/register">Start free trial</Link>
                </Button>
              </>
            )}
          </div>

          <Button variant="ghost" size="icon-sm" className="ml-auto md:hidden" onClick={() => setOpen((v) => !v)} aria-label="Menu">
            {open ? <X /> : <Menu />}
          </Button>
        </div>

        {open && (
          <div className="border-t px-4 py-3 md:hidden">
            <nav className="flex flex-col gap-1">
              {NAV.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className="rounded-md px-3 py-2 text-sm hover:bg-accent">
                  {item.label}
                </NavLink>
              ))}
              <div className="mt-2 flex gap-2">
                <Button variant="outline" className="flex-1" asChild><Link to="/login">Sign in</Link></Button>
                <Button className="flex-1" asChild><Link to="/register">Start free</Link></Button>
              </div>
            </nav>
          </div>
        )}
      </header>

      <main className="flex-1">
        <React.Suspense fallback={<PageFallback />}>
          <Outlet />
        </React.Suspense>
      </main>

      <footer className="border-t bg-muted/30">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-4 lg:px-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-semibold">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Store className="h-3.5 w-3.5" />
              </span>
              RetailSuite
            </div>
            <p className="text-sm text-muted-foreground">
              Point-of-sale software for retailers in Bangladesh and beyond.
            </p>
          </div>

          <FooterCol
            title="Products"
            links={[
              ['Clothing POS', '/products/clothing-pos'],
              ['Supershop POS', '/products/super-shop-pos'],
              ['Restaurant POS', '/products/restaurant-pos'],
              ['Pharmacy POS', '/products/pharmacy-pos'],
              ['Pricing', '/pricing'],
              ['Features', '/features'],
            ]}
          />
          <FooterCol title="Company" links={[['About', '/contact'], ['Contact', '/contact']]} />
          <FooterCol title="Account" links={[['Sign in', '/login'], ['Create account', '/register']]} />
        </div>
        <div className="border-t px-4 py-4 text-center text-xs text-muted-foreground lg:px-6">
          © {new Date().getFullYear()} RetailSuite. All rights reserved.
        </div>
      </footer>
    </div>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold">{title}</p>
      <ul className="space-y-1.5">
        {links.map(([label, to]) => (
          <li key={label}>
            <Link to={to} className="text-sm text-muted-foreground hover:text-foreground">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
