import * as React from 'react';
import { useLocation } from 'react-router-dom';
import { navLabelFor } from '@/layouts/AppLayout';
import { useAuth } from '@/hooks/useAuth';
import { useSite } from '@/features/public/useSite';
import { absoluteUrl, isPublicPath, routeSeoFor } from '@/lib/seo';

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
    const appPage = navLabelFor(pathname);

    // Signed in, inside the app, and the session knows which shop: lead with
    // the shop. Deliberately NOT branded - someone with three branches open in
    // three tabs needs to tell them apart, and the brand is the same in all
    // three.
    if (session && shop && appPage) {
      document.title = `${shop} — ${appPage}`;
      return;
    }
    if (session && shop && !publicTitleFor(pathname)) {
      document.title = shop;
      return;
    }

    // A public page. The admin's own text wins, then the built-in name.
    const configured = site?.seo.pages.find((page) => page.path === pathname)?.title?.trim();
    const home = pathname === '/';
    const template = site?.seo.titleTemplate?.includes('%s') ? site.seo.titleTemplate : `%s — ${brand}`;
    const defaultTitle = site?.seo.defaultTitle?.trim();

    let title: string;
    if (configured) {
      title = template.replace('%s', configured);
    } else if (home && defaultTitle) {
      // The home title is used WHOLE. It already names the brand, and running
      // it through the template produced "Brand — thing | Brand". This was
      // unreachable before: every known route resolved a page name first, so
      // the one field labelled "home page title" did nothing at all.
      title = defaultTitle;
    } else {
      const builtIn = publicTitleFor(pathname);
      title = builtIn ? template.replace('%s', builtIn) : (defaultTitle || `${brand} — ${TAGLINE}`);
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

  /**
   * The per-page tags, which change on every navigation.
   *
   * The build step bakes these into each page's HTML, which is what crawlers
   * and share cards read. This keeps them honest AFTERWARDS: once the SPA has
   * booted, moving from /pricing to /contact would otherwise leave the
   * canonical link and the Open Graph block describing the page the visitor
   * arrived on. Anything that reads the live DOM - Google's renderer, a
   * share-preview extension, a person checking - would be told the wrong page.
   */
  React.useEffect(() => {
    if (!site || !isPublicPath(pathname)) return;

    const configured = site.seo.pages.find((page) => page.path === pathname);
    const builtIn = routeSeoFor(pathname);
    const description =
      configured?.description?.trim() ||
      (pathname === '/' ? site.seo.defaultDescription?.trim() : '') ||
      builtIn?.description ||
      site.seo.defaultDescription?.trim();
    const url = absoluteUrl(site.seo.canonicalBaseUrl, pathname);

    const meta = (name: string, content: string, property = false) => {
      if (!content) return;
      const attr = property ? 'property' : 'name';
      setHeadTag(
        `meta[${attr}='${name}']`,
        () => {
          const el = document.createElement('meta');
          el.setAttribute(attr, name);
          return el;
        },
        (el) => el.setAttribute('content', content),
      );
    };

    if (description) meta('description', description);
    meta('og:title', document.title, true);
    meta('og:url', url, true);
    meta('og:site_name', site.name, true);
    if (description) meta('og:description', description, true);
    if (site.socialImageUrl) meta('og:image', site.socialImageUrl, true);
    meta('twitter:title', document.title);
    if (description) meta('twitter:description', description);

    if (site.seo.canonicalBaseUrl) {
      setHeadTag(
        "link[rel='canonical']",
        () => Object.assign(document.createElement('link'), { rel: 'canonical' }),
        (el) => el.setAttribute('href', url),
      );
    }
    // A staging build must keep saying so on every page, not only the first.
    meta('robots', site.seo.indexable ? 'index,follow' : 'noindex,nofollow');
  }, [site, pathname]);

  return null;
}
