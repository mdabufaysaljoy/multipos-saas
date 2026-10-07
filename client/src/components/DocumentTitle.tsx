import * as React from 'react';
import { useLocation } from 'react-router-dom';
import { navLabelFor } from '@/layouts/AppLayout';
import { useAuth } from '@/hooks/useAuth';
import { useSite } from '@/features/public/useSite';

/** Used until the settings load, and if they never do. */
const BRAND = 'Retailer Suites';
const TAGLINE = 'Point of sale for your business';

/** Creates the link/meta if it is not already in the document, then sets it. */
function setHeadTag(selector: string, create: () => HTMLElement, apply: (el: HTMLElement) => void) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = create();
    document.head.appendChild(el);
  }
  apply(el);
}

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
  '/faq': 'Frequently asked questions',
  '/privacy': 'Privacy policy',
  '/terms': 'Terms of service',
  '/refunds': 'Refund policy',
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
 * Signed out it is the product: "Retailer Suites — Point of sale for your business".
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
  const site = useSite();

  React.useEffect(() => {
    const shop = activeStore?.name?.trim();
    const brand = site?.name?.trim() || BRAND;
    // A per-page title the platform admin wrote wins over the built-in one.
    const configured = site?.seo.pages.find((page) => page.path === pathname)?.title?.trim();
    const page = navLabelFor(pathname) ?? (configured || publicTitleFor(pathname));

    let title: string;
    if (session && shop) {
      // Signed in, and the session knows which shop: lead with the shop.
      // Deliberately NOT branded - someone with three branches open in three
      // tabs needs to tell them apart, and the brand is the same in all three.
      title = page ? `${shop} — ${page}` : shop;
    } else if (page) {
      // The admin's template, with the page's own title in place of %s.
      const template = site?.seo.titleTemplate?.includes('%s') ? site.seo.titleTemplate : `%s — ${brand}`;
      title = template.replace('%s', page);
    } else {
      title = site?.seo.defaultTitle?.trim() || `${brand} — ${TAGLINE}`;
    }

    document.title = title;
  }, [pathname, session, activeStore?.name, site]);

  // The favicon, theme colour and description follow the settings too, so a
  // rebrand does not need a deploy and an edit to index.html.
  React.useEffect(() => {
    if (!site) return;

    if (site.faviconUrl) {
      setHeadTag(
        "link[rel='icon']",
        () => Object.assign(document.createElement('link'), { rel: 'icon' }),
        (el) => {
          el.setAttribute('href', site.faviconUrl);
          // Let the browser sniff it: the uploaded file may be SVG or WebP.
          el.removeAttribute('type');
        },
      );
    }

    if (site.primaryColor) {
      setHeadTag(
        "meta[name='theme-color']",
        () => Object.assign(document.createElement('meta'), { name: 'theme-color' }),
        (el) => el.setAttribute('content', site.primaryColor),
      );
    }

    if (site.seo.googleSiteVerification) {
      setHeadTag(
        "meta[name='google-site-verification']",
        () => Object.assign(document.createElement('meta'), { name: 'google-site-verification' }),
        (el) => el.setAttribute('content', site.seo.googleSiteVerification),
      );
    }
  }, [site]);

  // The description changes per page, so it is its own effect.
  React.useEffect(() => {
    if (!site) return;
    const configured = site.seo.pages.find((page) => page.path === pathname)?.description?.trim();
    const description = configured || site.seo.defaultDescription?.trim();
    if (!description) return;
    setHeadTag(
      "meta[name='description']",
      () => Object.assign(document.createElement('meta'), { name: 'description' }),
      (el) => el.setAttribute('content', description),
    );
  }, [site, pathname]);

  return null;
}
