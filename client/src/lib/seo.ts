/**
 * What search engines and social networks are told about each public page.
 *
 * One definition, read by two very different consumers:
 *
 *  - `scripts/prerender.mjs` at BUILD time, which writes a real HTML file per
 *    route with these tags already in it. That is the only thing that works
 *    for Facebook, WhatsApp, LinkedIn and X, whose crawlers do not run
 *    JavaScript at all - a tag added at runtime is a tag they never see.
 *  - `DocumentTitle` at RUNTIME, so the tags stay correct when somebody
 *    navigates between pages inside the already-loaded app.
 *
 * Keeping them in one file is the point: two lists would drift, and the half
 * that drifted would be the half nobody can see without a crawler.
 */

/** Built-in copy, used until the platform admin writes their own. */
export interface RouteSeo {
  path: string;
  title: string;
  description: string;
  /** Pages that are not content: linked, but kept out of the sitemap. */
  noindex?: boolean;
}

export const PUBLIC_ROUTES: RouteSeo[] = [
  {
    path: '/',
    title: 'Point of sale for your business',
    description:
      'Point-of-sale software that fits the shop you actually run: clothing, super shop, restaurant and pharmacy. Billing, stock, staff and reports in one account.',
  },
  {
    path: '/products',
    title: 'POS systems',
    description:
      'Four point-of-sale systems built for how each trade really works — clothing, super shop, restaurant and pharmacy — on one platform and one account.',
  },
  {
    path: '/pricing',
    title: 'Pricing',
    description:
      'Simple monthly and yearly plans with every point-of-sale feature included. Start free, no card required, and upgrade when the shop grows.',
  },
  {
    path: '/features',
    title: 'Platform',
    description:
      'Billing, inventory, barcode scanning, thermal printing, staff permissions, loyalty and reporting — everything the counter and the back office need.',
  },
  {
    path: '/contact',
    title: 'Contact',
    description: 'Talk to us about plans, moving an existing catalogue, or getting your counters set up.',
  },
  { path: '/faq', title: 'Frequently asked questions', description: 'Answers about trials, pricing, devices and getting started.' },
  { path: '/privacy', title: 'Privacy policy', description: 'What we collect, why we collect it, and what we do with it.' },
  { path: '/terms', title: 'Terms of service', description: 'The agreement between your business and ours.' },
  { path: '/refunds', title: 'Refund policy', description: 'When a payment can be refunded, and how.' },
];

/** The per-POS marketing pages. Their slugs must match `products.data.ts`. */
export const PRODUCT_SLUGS = ['clothing-pos', 'super-shop-pos', 'restaurant-pos', 'pharmacy-pos'] as const;

/** Signed-in routes. Never indexed, never in the sitemap. */
export const PRIVATE_PREFIXES = ['/pos', '/platform', '/onboarding', '/settings', '/login', '/register', '/forgot-password'];

export const isPublicPath = (path: string) => !PRIVATE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

/** The built-in entry for a path, if there is one. */
export const routeSeoFor = (path: string): RouteSeo | null =>
  PUBLIC_ROUTES.find((route) => route.path === path) ?? null;

/**
 * Applies the admin's title template.
 *
 * The home page is the exception: its title is used whole, because it already
 * names the brand and running it through `%s — Brand` names the brand twice.
 */
export function composeTitle(options: {
  path: string;
  pageTitle: string | null;
  template: string;
  brand: string;
  homeTitle: string | null;
}): string {
  const { path, pageTitle, template, brand, homeTitle } = options;
  if (path === '/' && !pageTitle && homeTitle) return homeTitle;
  const title = pageTitle ?? routeSeoFor(path)?.title ?? null;
  if (!title) return homeTitle || brand;
  const shape = template.includes('%s') ? template : `%s — ${brand}`;
  return shape.replace('%s', title);
}

/** An absolute URL on the canonical origin, for canonical links and og:url. */
export const absoluteUrl = (base: string, path: string) =>
  `${base.replace(/\/$/, '')}${path === '/' ? '' : path}` || base.replace(/\/$/, '');
