import { BRANDING } from '../../config/branding';
import { getPlatformSettings, type SiteSettings } from '../../models/PlatformSettings';

/**
 * What the public website is told about itself.
 *
 * The platform admin edits a `site` block on the settings singleton; this
 * resolves it into the shape the browser consumes, filling every blank from
 * `config/branding.ts` - which still reads the environment. That fallback is
 * the whole contract: an operator who never opens the branding screen gets
 * exactly the site the deployment was configured with, and clearing a field is
 * a way to go back to it rather than a way to break the header.
 *
 * It is served to anonymous visitors, so nothing secret may ever be added.
 * Credentials live elsewhere on the same document and are `select: false`
 * besides; this builds its payload field by field rather than spreading the
 * settings object, so a secret added later cannot leak by accident.
 */

export interface PublicSite {
  name: string;
  tagline: string;
  logoUrl: string;
  faviconUrl: string;
  socialImageUrl: string;
  primaryColor: string;
  seo: {
    titleTemplate: string;
    defaultTitle: string;
    defaultDescription: string;
    keywords: string[];
    canonicalBaseUrl: string;
    twitterHandle: string;
    googleSiteVerification: string;
    indexable: boolean;
    pages: { path: string; title: string; description: string }[];
  };
  contact: SiteSettings['contact'];
  social: SiteSettings['social'];
  content: SiteSettings['content'];
}

/** Trim, and fall back when what is left is empty. */
const or = (value: string | undefined | null, fallback: string) => {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? fallback : trimmed;
};

const EMPTY_CONTACT: SiteSettings['contact'] = {
  email: '',
  phone: '',
  whatsapp: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  postcode: '',
  country: '',
  mapUrl: '',
};

const EMPTY_SOCIAL: SiteSettings['social'] = { facebook: '', instagram: '', linkedin: '', youtube: '', x: '' };

const EMPTY_CONTENT: SiteSettings['content'] = { privacyPolicy: '', terms: '', refundPolicy: '', faq: [] };

/**
 * A short cache.
 *
 * Every page view on the public site reads this, and it changes a few times a
 * year. Sixty seconds keeps the database out of the hot path while still
 * letting an admin see an edit land without waiting or redeploying.
 */
const CACHE_MS = 60_000;
let cached: { at: number; value: PublicSite } | null = null;

class SiteService {
  /** Drops the cache. Called when the platform admin saves. */
  invalidate() {
    cached = null;
  }

  async publicSite(): Promise<PublicSite> {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

    const settings = await getPlatformSettings();
    const site = (settings.site ?? {}) as Partial<SiteSettings>;
    const seo = site.seo ?? ({} as Partial<SiteSettings['seo']>);

    const name = or(site.name, BRANDING.productName);
    const value: PublicSite = {
      name,
      tagline: or(site.tagline, ''),
      logoUrl: or(site.logoUrl, ''),
      faviconUrl: or(site.faviconUrl, '/favicon.svg'),
      socialImageUrl: or(site.socialImageUrl, ''),
      primaryColor: or(site.primaryColor, BRANDING.primaryColor),
      seo: {
        // "%s" is the page's own title. The default puts the brand after it,
        // which is what search results read best.
        titleTemplate: or(seo.titleTemplate, `%s — ${name}`),
        defaultTitle: or(seo.defaultTitle, name),
        defaultDescription: or(seo.defaultDescription, ''),
        keywords: Array.isArray(seo.keywords) ? seo.keywords.filter(Boolean) : [],
        canonicalBaseUrl: or(seo.canonicalBaseUrl, BRANDING.websiteUrl).replace(/\/$/, ''),
        twitterHandle: or(seo.twitterHandle, ''),
        googleSiteVerification: or(seo.googleSiteVerification, ''),
        // Defaults to true so a fresh install is indexable; an operator turns
        // it off for staging.
        indexable: seo.indexable !== false,
        pages: (seo.pages ?? [])
          .filter((page) => page && typeof page.path === 'string' && page.path.startsWith('/'))
          .map((page) => ({ path: page.path, title: page.title ?? '', description: page.description ?? '' })),
      },
      contact: {
        ...EMPTY_CONTACT,
        ...(site.contact ?? {}),
        // The support address and number already had a home on this document
        // before the site block existed; they stay the fallback so nobody has
        // to retype what they already entered.
        email: or(site.contact?.email, settings.supportEmail ?? ''),
        phone: or(site.contact?.phone, settings.supportPhone ?? ''),
      },
      social: { ...EMPTY_SOCIAL, ...(site.social ?? {}) },
      content: {
        ...EMPTY_CONTENT,
        ...(site.content ?? {}),
        faq: (site.content?.faq ?? []).filter((entry) => entry?.question && entry?.answer),
      },
    };

    cached = { at: Date.now(), value };
    return value;
  }
}

export const siteService = new SiteService();
