import { Schema, model } from 'mongoose';
import type { BaseDoc } from './types';

export interface PaymentInstruction {
  method: 'bkash' | 'nagad' | 'bank';
  label: string;
  accountNumber: string;
  accountName: string;
  steps: string[];
  isActive: boolean;
}

/**
 * Singleton holding platform-wide configuration a platform admin can edit at
 * runtime - notably the manual-payment instructions shown to customers during
 * an upgrade. These are deliberately NOT hardcoded: account numbers change, and
 * a redeploy should not be needed to change them.
 */
export interface PlatformSettingsDoc extends BaseDoc {
  key: string;
  paymentInstructions: PaymentInstruction[];
  supportEmail: string;
  supportPhone: string;
  /** Cost per SMS segment, in minor units. Set by the platform admin. */
  smsCostMinor: number;
  /** Cost per email, in minor units. Charged the same way as SMS. */
  emailCostMinor: number;
  /** Cost per AI request, in minor units. For AI services billed per use. */
  aiRequestCostMinor: number;
  /**
   * SMTP credentials. `select: false` on the password keeps it out of every
   * ordinary query, and the tenant-facing API never returns this block at all.
   */
  /**
   * SMS gateway credentials.
   *
   * `apiKey` is `select: false` for the same reason the SMTP password is: it
   * must never ride along on an ordinary settings read, and no tenant-facing
   * response returns this block at all.
   */
  sms: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    senderId: string;
    enabled: boolean;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    fromName: string;
    fromEmail: string;
    enabled: boolean;
  };
  currency: string;
  /** Email digests to platform admins about payments needing attention. */
  paymentAlerts: {
    enabled: boolean;
    /** Sent in addition to every active platform administrator. */
    recipients: string[];
  };
  /**
   * Which ways of paying are switched on, and the credentials for the ones
   * that need them.
   *
   * It lives here rather than only in the environment because turning a
   * gateway on, or falling back to manual transfers when it misbehaves, is
   * something an operator does at the moment it is needed - not something
   * worth a deploy. The environment remains the BOOTSTRAP: a key set there is
   * used until one is saved here, so a fresh install works before anybody
   * opens the screen.
   */
  payments: PaymentSettings;
  /**
   * The public website: who it says we are, what search engines are told, and
   * the pages whose text used to be hardcoded.
   *
   * It lives here rather than in environment variables because a brand name,
   * an address and a privacy policy are things an operator changes - sometimes
   * urgently, often without a deploy. `config/branding.ts` still reads the env
   * and remains the fallback, so an empty field here means "whatever the
   * deployment was configured with" rather than an empty website.
   *
   * Nothing in this block is a secret: it is served to anonymous visitors by
   * `GET /public/site`, so nothing confidential may be added to it.
   */
  site: SiteSettings;
}

export interface PaymentSettings {
  /**
   * Manual bank/bKash/Nagad transfers, where a customer sends money and a
   * platform admin confirms it by hand.
   *
   * Switchable because once an automatic gateway is live, leaving the manual
   * route visible invites customers down the slow path that needs a human.
   */
  manualEnabled: boolean;
  zinipay: {
    /**
     * `select: false` for the same reason the SMTP password is: it must never
     * ride along on an ordinary settings read, and no tenant-facing response
     * returns it at all.
     */
    apiKey: string;
    baseUrl: string;
    enabled: boolean;
  };
}

/** One public page's own search-engine text. */
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
  /** Blank means "fall back to the deployment's configured branding". */
  name: string;
  tagline: string;
  logoUrl: string;
  faviconUrl: string;
  /** The image social networks show when a link is shared. */
  socialImageUrl: string;
  primaryColor: string;

  seo: {
    /** `%s` is replaced by the page's own title. */
    titleTemplate: string;
    defaultTitle: string;
    defaultDescription: string;
    keywords: string[];
    /** Absolute origin used for canonical URLs and the sitemap. */
    canonicalBaseUrl: string;
    twitterHandle: string;
    googleSiteVerification: string;
    /**
     * False puts `noindex` on every page and an empty sitemap.
     *
     * Staging deployments share this codebase; a staging site that out-ranks
     * production is a real and very annoying failure.
     */
    indexable: boolean;
    /** Per-page overrides, keyed by route. */
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

  /** Long-form pages, written as Markdown by the platform admin. */
  content: {
    privacyPolicy: string;
    terms: string;
    refundPolicy: string;
    faq: SiteFaqEntry[];
  };
}

const instructionSchema = new Schema<PaymentInstruction>(
  {
    method: { type: String, enum: ['bkash', 'nagad', 'bank'], required: true },
    label: { type: String, required: true },
    accountNumber: { type: String, required: true },
    accountName: { type: String, default: '' },
    steps: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { _id: false },
);

const platformSettingsSchema = new Schema<PlatformSettingsDoc>(
  {
    // Fixed key so there is exactly one document.
    key: { type: String, default: 'platform', unique: true },
    paymentInstructions: { type: [instructionSchema], default: [] },
    supportEmail: { type: String, default: '' },
    supportPhone: { type: String, default: '' },
    smsCostMinor: { type: Number, default: 50, min: 0 },
    emailCostMinor: { type: Number, default: 0, min: 0 },
    aiRequestCostMinor: { type: Number, default: 0, min: 0 },
    sms: {
      provider: { type: String, default: 'alpha' },
      apiKey: { type: String, default: '', select: false },
      baseUrl: { type: String, default: 'https://api.sms.net.bd' },
      senderId: { type: String, default: '' },
      enabled: { type: Boolean, default: false },
    },
    smtp: {
      host: { type: String, default: '' },
      port: { type: Number, default: 587 },
      secure: { type: Boolean, default: false },
      username: { type: String, default: '' },
      password: { type: String, default: '', select: false },
      fromName: { type: String, default: '' },
      fromEmail: { type: String, default: '' },
      enabled: { type: Boolean, default: false },
    },
    currency: { type: String, default: 'BDT' },
    paymentAlerts: {
      enabled: { type: Boolean, default: true },
      recipients: { type: [String], default: [] },
    },
    payments: {
      manualEnabled: { type: Boolean, default: true },
      zinipay: {
        apiKey: { type: String, default: '', select: false },
        baseUrl: { type: String, default: 'https://api.zinipay.com', trim: true, maxlength: 300 },
        enabled: { type: Boolean, default: false },
      },
    },
    site: {
      // Every string defaults to empty on purpose: empty means "use the
      // deployment's configured branding", so an operator who never opens this
      // screen gets exactly the site they had before it existed.
      name: { type: String, default: '', trim: true, maxlength: 120 },
      tagline: { type: String, default: '', trim: true, maxlength: 200 },
      logoUrl: { type: String, default: '', trim: true, maxlength: 600 },
      faviconUrl: { type: String, default: '', trim: true, maxlength: 600 },
      socialImageUrl: { type: String, default: '', trim: true, maxlength: 600 },
      primaryColor: { type: String, default: '', trim: true, maxlength: 32 },
      seo: {
        titleTemplate: { type: String, default: '', trim: true, maxlength: 120 },
        defaultTitle: { type: String, default: '', trim: true, maxlength: 200 },
        defaultDescription: { type: String, default: '', trim: true, maxlength: 400 },
        keywords: { type: [String], default: [] },
        canonicalBaseUrl: { type: String, default: '', trim: true, maxlength: 300 },
        twitterHandle: { type: String, default: '', trim: true, maxlength: 60 },
        googleSiteVerification: { type: String, default: '', trim: true, maxlength: 200 },
        indexable: { type: Boolean, default: true },
        pages: {
          type: [
            new Schema<SitePageSeo>(
              {
                path: { type: String, required: true, trim: true, maxlength: 200 },
                title: { type: String, default: '', trim: true, maxlength: 200 },
                description: { type: String, default: '', trim: true, maxlength: 400 },
              },
              { _id: false },
            ),
          ],
          default: [],
        },
      },
      contact: {
        email: { type: String, default: '', trim: true, maxlength: 200 },
        phone: { type: String, default: '', trim: true, maxlength: 40 },
        whatsapp: { type: String, default: '', trim: true, maxlength: 40 },
        addressLine1: { type: String, default: '', trim: true, maxlength: 200 },
        addressLine2: { type: String, default: '', trim: true, maxlength: 200 },
        city: { type: String, default: '', trim: true, maxlength: 120 },
        postcode: { type: String, default: '', trim: true, maxlength: 40 },
        country: { type: String, default: '', trim: true, maxlength: 120 },
        mapUrl: { type: String, default: '', trim: true, maxlength: 600 },
      },
      social: {
        facebook: { type: String, default: '', trim: true, maxlength: 300 },
        instagram: { type: String, default: '', trim: true, maxlength: 300 },
        linkedin: { type: String, default: '', trim: true, maxlength: 300 },
        youtube: { type: String, default: '', trim: true, maxlength: 300 },
        x: { type: String, default: '', trim: true, maxlength: 300 },
      },
      content: {
        // Markdown. Rendered to HTML on the client with escaping, never
        // injected raw - a platform admin is trusted, but a stored-XSS hole
        // that only an admin can open is still a stored-XSS hole.
        privacyPolicy: { type: String, default: '', maxlength: 60_000 },
        terms: { type: String, default: '', maxlength: 60_000 },
        refundPolicy: { type: String, default: '', maxlength: 60_000 },
        faq: {
          type: [
            new Schema<SiteFaqEntry>(
              {
                question: { type: String, required: true, trim: true, maxlength: 300 },
                answer: { type: String, required: true, trim: true, maxlength: 4000 },
              },
              { _id: false },
            ),
          ],
          default: [],
        },
      },
    },
  },
  { timestamps: true },
);

export const PlatformSettingsModel = model<PlatformSettingsDoc>('PlatformSettings', platformSettingsSchema);

/** Reads the singleton, creating it with defaults on first use. */
export async function getPlatformSettings() {
  const existing = await PlatformSettingsModel.findOne({ key: 'platform' }).lean();
  if (existing) return existing;
  const created = await PlatformSettingsModel.create({ key: 'platform' });
  return created.toObject();
}
