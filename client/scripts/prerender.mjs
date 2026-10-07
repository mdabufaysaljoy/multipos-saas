/**
 * Writes a real HTML file per public route, with its tags already in it.
 *
 * WHY THIS EXISTS. The site is a client-rendered SPA. Googlebot does run
 * JavaScript, so runtime tags are eventually indexed - but Facebook, WhatsApp,
 * LinkedIn and X do not run it at all. A share card built from tags that only
 * appear after React boots is a card those crawlers never see, so every shared
 * link renders blank forever. No amount of runtime head management fixes that;
 * the tags have to be in the bytes the server sends.
 *
 * WHAT IT DOES NOT DO. It does not render the page body. The markup still
 * arrives from the SPA bundle, exactly as before. This is about the `<head>`,
 * which is what crawlers and share cards read, and it buys that without the
 * risk of a rendering rewrite.
 *
 * LIVE SETTINGS. The platform admin owns the brand name, descriptions and
 * social image, so this reads them from the API at build time. If the API is
 * not reachable - a CI box with no database, an offline build - it falls back
 * to the built-in copy and says so, because a build that fails because a
 * marketing description could not be fetched would be a worse outcome than a
 * build with slightly stale text.
 *
 * Run automatically after `vite build`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '../dist');
const API = (process.env.PRERENDER_API_URL ?? process.env.VITE_API_URL ?? 'http://localhost:4100/api').replace(/\/$/, '');

// The route table is TypeScript, so it is parsed out rather than imported -
// this script runs on plain node with no build step of its own. A mismatch is
// caught by the test that compares the two lists.
const seoSource = await readFile(resolve(HERE, '../src/lib/seo.ts'), 'utf8');

function parseRoutes() {
  const block = seoSource.slice(seoSource.indexOf('export const PUBLIC_ROUTES'), seoSource.indexOf('export const PRODUCT_SLUGS'));
  const routes = [];
  const entry = /path:\s*'([^']+)',\s*\n?\s*title:\s*'([^']*)',\s*\n?\s*description:\s*\n?\s*'([^']*)'/g;
  // Entries are written across several lines, so the source is flattened first.
  const flat = block.replace(/\s+/g, ' ');
  const oneLine = /\{ path: '([^']+)', title: '([^']*)', description: '([^']*)',? \}/g;
  let match;
  while ((match = oneLine.exec(flat))) routes.push({ path: match[1], title: match[2], description: match[3] });
  void entry;
  return routes;
}

function parseSlugs() {
  const line = /export const PRODUCT_SLUGS = \[([^\]]+)\]/.exec(seoSource);
  return line ? [...line[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
}

/** The admin's settings, or null when they cannot be read. */
async function fetchSite() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${API}/public/site`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data ?? null;
  } catch {
    return null;
  }
}

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** JSON-LD is script CONTENT, so `<` must not be able to close the tag. */
const jsonLd = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

function headFor({ route, site, base, brand }) {
  const configured = (site?.seo?.pages ?? []).find((page) => page.path === route.path);
  const pageTitle = configured?.title?.trim() || null;
  const homeTitle = site?.seo?.defaultTitle?.trim() || null;
  const template = site?.seo?.titleTemplate?.includes('%s') ? site.seo.titleTemplate : `%s — ${brand}`;

  const title =
    route.path === '/' && !pageTitle && homeTitle
      ? homeTitle
      : template.replace('%s', pageTitle ?? route.title);

  const description =
    configured?.description?.trim() || (route.path === '/' ? site?.seo?.defaultDescription?.trim() : '') || route.description;

  const url = `${base}${route.path === '/' ? '' : route.path}`;
  const image = site?.socialImageUrl?.trim() || '';
  const indexable = site?.seo?.indexable !== false;

  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    // A staging deployment must not be allowed to out-rank the real site.
    indexable ? '<meta name="robots" content="index,follow">' : '<meta name="robots" content="noindex,nofollow">',
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${escapeHtml(brand)}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : '',
    // `summary_large_image` only renders if there IS an image; without one the
    // small card looks better than a large empty one.
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    image ? `<meta name="twitter:image" content="${escapeHtml(image)}">` : '',
    site?.seo?.twitterHandle?.trim() ? `<meta name="twitter:site" content="${escapeHtml(site.seo.twitterHandle)}">` : '',
    site?.seo?.googleSiteVerification?.trim()
      ? `<meta name="google-site-verification" content="${escapeHtml(site.seo.googleSiteVerification)}">`
      : '',
    site?.faviconUrl?.trim() ? `<link rel="icon" href="${escapeHtml(site.faviconUrl)}">` : '',
    site?.primaryColor?.trim() ? `<meta name="theme-color" content="${escapeHtml(site.primaryColor)}">` : '',
  ];

  // ---- structured data ----------------------------------------------------
  const sameAs = Object.values(site?.social ?? {}).filter((value) => typeof value === 'string' && value.trim() !== '');
  const organisation = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: brand,
    url: base,
    ...(site?.logoUrl ? { logo: site.logoUrl } : {}),
    ...(sameAs.length ? { sameAs } : {}),
    ...(site?.contact?.email || site?.contact?.phone
      ? {
          contactPoint: [
            {
              '@type': 'ContactPoint',
              contactType: 'customer support',
              ...(site.contact.email ? { email: site.contact.email } : {}),
              ...(site.contact.phone ? { telephone: site.contact.phone } : {}),
            },
          ],
        }
      : {}),
    ...(site?.contact?.addressLine1 || site?.contact?.city
      ? {
          address: {
            '@type': 'PostalAddress',
            ...(site.contact.addressLine1 ? { streetAddress: [site.contact.addressLine1, site.contact.addressLine2].filter(Boolean).join(', ') } : {}),
            ...(site.contact.city ? { addressLocality: site.contact.city } : {}),
            ...(site.contact.postcode ? { postalCode: site.contact.postcode } : {}),
            ...(site.contact.country ? { addressCountry: site.contact.country } : {}),
          },
        }
      : {}),
  };

  const structured = [];
  if (route.path === '/') structured.push(organisation);

  // Only real answers go in: an empty FAQPage is a structured-data error
  // rather than a missing feature.
  const faq = (site?.content?.faq ?? []).filter((entry) => entry?.question && entry?.answer);
  if (route.path === '/faq' && faq.length > 0) {
    structured.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map((entry) => ({
        '@type': 'Question',
        name: entry.question,
        acceptedAnswer: { '@type': 'Answer', text: entry.answer },
      })),
    });
  }

  if (route.path !== '/') {
    structured.push({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: base },
        { '@type': 'ListItem', position: 2, name: route.title, item: url },
      ],
    });
  }

  for (const data of structured) {
    tags.push(`<script type="application/ld+json">${jsonLd(data)}</script>`);
  }

  return tags.filter(Boolean).join('\n    ');
}

/** Replaces the template's own title/description, then injects the rest. */
function render(template, head) {
  return template
    .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
    .replace(/<meta\s+name="description"[^>]*>\s*/i, '')
    .replace(/<link\s+rel="icon"[^>]*>\s*/i, '')
    .replace('</head>', `  ${head}\n  </head>`);
}

async function main() {
  const template = await readFile(resolve(DIST, 'index.html'), 'utf8');
  const site = await fetchSite();
  if (!site) {
    console.warn(`  prerender: ${API}/public/site unreachable — using built-in copy.`);
  }

  const brand = site?.name?.trim() || 'Retailer Suites';
  const base = (site?.seo?.canonicalBaseUrl?.trim() || 'https://retailersuites.com').replace(/\/$/, '');
  const indexable = site?.seo?.indexable !== false;

  const routes = parseRoutes();
  const slugs = parseSlugs();
  if (routes.length === 0) throw new Error('prerender: no public routes parsed from src/lib/seo.ts');

  // Each POS gets its own page, and its own entry in the sitemap.
  const productRoutes = slugs.map((slug) => ({
    path: `/products/${slug}`,
    title: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description: `${slug.replace(/-pos$/, '').replace(/-/g, ' ')} point of sale: billing, stock and reporting built for how the trade actually works.`,
  }));

  const all = [...routes, ...productRoutes];
  for (const route of all) {
    const head = headFor({ route, site, base, brand });
    const html = render(template, head);
    const dir = route.path === '/' ? DIST : resolve(DIST, `.${route.path}`);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'index.html'), html, 'utf8');
  }

  // ---- sitemap.xml --------------------------------------------------------
  // Policy pages are listed: they are real pages people search for, and a
  // sitemap that omits them makes them look like an afterthought.
  const today = new Date().toISOString().slice(0, 10);
  const priority = (path) => (path === '/' ? '1.0' : path.startsWith('/products') || path === '/pricing' ? '0.8' : '0.5');
  const sitemap = indexable
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${all
        .map(
          (route) =>
            `  <url>\n    <loc>${escapeHtml(`${base}${route.path === '/' ? '' : route.path}`)}</loc>\n    <lastmod>${today}</lastmod>\n    <priority>${priority(route.path)}</priority>\n  </url>`,
        )
        .join('\n')}\n</urlset>\n`
    : `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n`;
  await writeFile(resolve(DIST, 'sitemap.xml'), sitemap, 'utf8');

  // ---- robots.txt ---------------------------------------------------------
  // It belongs HERE, at the site root, not on the API host: a crawler reads
  // https://thesite.com/robots.txt and nothing else.
  const robots = indexable
    ? ['User-agent: *', 'Allow: /', '', '# The signed-in app is not content.', 'Disallow: /pos', 'Disallow: /platform', 'Disallow: /onboarding', '', `Sitemap: ${base}/sitemap.xml`, '']
    : ['User-agent: *', 'Disallow: /', ''];
  await writeFile(resolve(DIST, 'robots.txt'), robots.join('\n'), 'utf8');

  console.log(
    `  prerender: ${all.length} pages, sitemap.xml and robots.txt` +
      `${site ? ` using live settings for "${brand}"` : ' using built-in copy'}` +
      `${indexable ? '' : ' (NOINDEX — this build asks search engines to stay away)'}`,
  );
}

main().catch((error) => {
  console.error('prerender failed:', error);
  process.exit(1);
});
