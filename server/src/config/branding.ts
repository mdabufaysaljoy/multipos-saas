import { env } from './env';

/**
 * The one place transactional emails read branding from. Product name, website
 * and colour come from the environment (defaults match the public site); the
 * support address is the platform setting an admin already maintains, read at
 * send time.
 */
export const BRANDING = {
  productName: env.BRAND_NAME,
  websiteUrl: env.BRAND_WEBSITE_URL.replace(/\/$/, ''),
  primaryColor: env.BRAND_PRIMARY_COLOR,
  /** The signed-in app, for links into billing. */
  appUrl: env.CLIENT_ORIGIN.split(',')[0].trim().replace(/\/$/, ''),
  timezone: env.BUSINESS_TIMEZONE,
} as const;
