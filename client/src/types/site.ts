/**
 * The public website's own settings, as the platform admin edits them and as
 * anonymous visitors read them.
 *
 * Every string may be empty, and empty is meaningful: it means "fall back to
 * whatever this deployment was configured with" rather than "blank". The admin
 * screen shows the resolved value beside each empty field so that is visible
 * rather than something to be guessed at.
 */

export interface SitePageSeo {
  /** The route it belongs to, e.g. `/pricing`. */
  path: string;
  title: string;
  description: string;
}

export interface SiteFaqEntry {
  question: string;
  answer: string;
}

export interface SiteSettings {
  name: string;
  tagline: string;
  logoUrl: string;
  faviconUrl: string;
  socialImageUrl: string;
  primaryColor: string;
  seo: {
    /** `%s` is replaced by the page's own title. */
    titleTemplate: string;
    defaultTitle: string;
    defaultDescription: string;
    keywords: string[];
    canonicalBaseUrl: string;
    twitterHandle: string;
    googleSiteVerification: string;
    /** False puts `noindex` everywhere — for staging deployments. */
    indexable: boolean;
    pages: SitePageSeo[];
  };
  contact: {
    email: string;
    phone: string;
    whatsapp: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    postcode: string;
    country: string;
    mapUrl: string;
  };
  social: {
    facebook: string;
    instagram: string;
    linkedin: string;
    youtube: string;
    x: string;
  };
  content: {
    privacyPolicy: string;
    terms: string;
    refundPolicy: string;
    faq: SiteFaqEntry[];
  };
}

/** The public routes an admin can give their own title and description. */
export const SEO_PAGES: { path: string; label: string }[] = [
  { path: '/', label: 'Home' },
  { path: '/products', label: 'POS systems' },
  { path: '/pricing', label: 'Pricing' },
  { path: '/features', label: 'Platform' },
  { path: '/contact', label: 'Contact' },
  { path: '/faq', label: 'FAQ' },
  { path: '/privacy', label: 'Privacy policy' },
  { path: '/terms', label: 'Terms' },
];
