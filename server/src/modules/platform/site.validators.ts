import { z } from 'zod';

/**
 * What a platform admin may set on the public website.
 *
 * Every field is optional: the screen saves one section at a time, and a blank
 * string is meaningful - it means "go back to the deployment's configured
 * value" rather than "set the site name to nothing".
 *
 * URLs are checked rather than taken on trust. A logo field that accepted
 * `javascript:` would put an admin-authored script into every visitor's page,
 * and these values are rendered into `href`/`src` on a page served to anonymous
 * people.
 */

const text = (max: number) => z.string().trim().max(max);

/** An http(s) URL, or a same-origin path. Never a `javascript:` or `data:` URI. */
const webUrl = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (value) => value === '' || /^https?:\/\//i.test(value) || value.startsWith('/'),
      'Enter a full https:// address, or a path beginning with /',
    );

const pageSeo = z
  .object({
    path: z.string().trim().min(1).max(200).regex(/^\//, 'A page path starts with /'),
    title: text(200).default(''),
    description: text(400).default(''),
  })
  .strict();

const faqEntry = z
  .object({
    question: z.string().trim().min(1, 'A question is required').max(300),
    answer: z.string().trim().min(1, 'An answer is required').max(4000),
  })
  .strict();

export const updateSiteSchema = z
  .object({
    name: text(120).optional(),
    tagline: text(200).optional(),
    logoUrl: webUrl(600).optional(),
    faviconUrl: webUrl(600).optional(),
    socialImageUrl: webUrl(600).optional(),
    // A CSS colour the site paints with; bounded so it cannot smuggle in a
    // declaration of its own.
    primaryColor: z
      .string()
      .trim()
      .max(32)
      .refine((value) => value === '' || /^#[0-9a-f]{3,8}$/i.test(value), 'Use a hex colour such as #4f46e5')
      .optional(),

    seo: z
      .object({
        titleTemplate: text(120).optional(),
        defaultTitle: text(200).optional(),
        defaultDescription: text(400).optional(),
        keywords: z.array(text(60)).max(40).optional(),
        canonicalBaseUrl: webUrl(300).optional(),
        twitterHandle: text(60).optional(),
        googleSiteVerification: text(200).optional(),
        indexable: z.boolean().optional(),
        pages: z.array(pageSeo).max(60).optional(),
      })
      .strict()
      .optional(),

    contact: z
      .object({
        email: z.union([z.literal(''), z.string().trim().email('Enter a valid email address').max(200)]).optional(),
        phone: text(40).optional(),
        whatsapp: text(40).optional(),
        addressLine1: text(200).optional(),
        addressLine2: text(200).optional(),
        city: text(120).optional(),
        postcode: text(40).optional(),
        country: text(120).optional(),
        mapUrl: webUrl(600).optional(),
      })
      .strict()
      .optional(),

    social: z
      .object({
        facebook: webUrl(300).optional(),
        instagram: webUrl(300).optional(),
        linkedin: webUrl(300).optional(),
        youtube: webUrl(300).optional(),
        x: webUrl(300).optional(),
      })
      .strict()
      .optional(),

    content: z
      .object({
        privacyPolicy: z.string().max(60_000).optional(),
        terms: z.string().max(60_000).optional(),
        refundPolicy: z.string().max(60_000).optional(),
        faq: z.array(faqEntry).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type UpdateSiteInput = z.infer<typeof updateSiteSchema>;
