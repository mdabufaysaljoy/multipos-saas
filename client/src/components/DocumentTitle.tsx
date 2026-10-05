import * as React from 'react';
import { useLocation } from 'react-router-dom';
import { navLabelFor } from '@/layouts/AppLayout';
import { useAuth } from '@/hooks/useAuth';

const BRAND = 'RetailerSWs';
const TAGLINE = 'Point of sale for your business';

/**
 * Pages outside the signed-in app, which have no sidebar entry to borrow a
 * name from.
 */
const PUBLIC_TITLES: Record<string, string> = {
  '/': TAGLINE,
  '/products': 'Products',
  '/pricing': 'Pricing',
  '/features': 'Features',
  '/contact': 'Contact',
  '/login': 'Sign in',
  '/register': 'Create a workspace',
  '/forgot-password': 'Reset your password',
  '/reset-password': 'Reset your password',
};

/** The longest public path that matches, so `/products/clothing` still resolves. */
function publicTitleFor(pathname: string): string | null {
  let best: { path: string; title: string } | null = null;
  for (const [path, title] of Object.entries(PUBLIC_TITLES)) {
    const matches = path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`);
    if (!matches) continue;
    if (!best || path.length > best.path.length) best = { path, title };
  }
  return best?.title ?? null;
}

/**
 * What the browser tab says.
 *
 * Signed out it is the product: "RetailSuite — Point of sale for your business".
 * Signed in it is the SHOP, because someone with three branches open in three
 * tabs needs to tell them apart at a glance: "Dhanmondi — Point of sale".
 *
 * The page name comes from the sidebar's own labels, so a screen renamed there
 * is renamed on the tab too. A path with no entry falls back to the shop alone
 * rather than inventing a name for it.
 */
export function DocumentTitle() {
  const { pathname } = useLocation();
  const { session, activeStore } = useAuth();

  React.useEffect(() => {
    const shop = activeStore?.name?.trim();
    const page = navLabelFor(pathname) ?? publicTitleFor(pathname);

    // Signed in, and the session knows which shop: lead with the shop.
    const title = session && shop ? (page ? `${shop} — ${page}` : shop) : `${BRAND} — ${page ?? TAGLINE}`;

    document.title = title;
  }, [pathname, session, activeStore?.name]);

  return null;
}
