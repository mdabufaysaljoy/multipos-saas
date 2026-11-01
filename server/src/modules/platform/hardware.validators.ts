import { z } from 'zod';
import { HARDWARE_CATEGORIES, HARDWARE_STATUSES } from '../../models/HardwareItem';

/**
 * What a platform admin may put in the hardware catalogue.
 *
 * Strict throughout: ids, timestamps and the resolved totals are server facts,
 * not inputs. Image addresses are checked rather than trusted, because they are
 * rendered into `src` on a page served to anonymous visitors - a `javascript:`
 * value there would be an admin-authored script in every visitor's browser.
 */

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,47}$/, 'Use 2-48 lowercase letters, digits or hyphens');

/** An http(s) address or a same-origin path. Never `javascript:` or `data:`. */
const imageUrl = z
  .string()
  .trim()
  .max(600)
  .refine(
    (value) => value === '' || /^https?:\/\//i.test(value) || value.startsWith('/'),
    'Enter a full https:// address, or a path beginning with /',
  );

/** Prices are integer minor units. ~10 million taka is far above any counter setup. */
const priceMinor = z.number().int().min(0).max(1_000_000_000);

const bullets = (max: number, length: number) => z.array(z.string().trim().min(1).max(length)).max(max);

export const hardwareSlugParams = z.object({ slug }).strict();

const itemFields = {
  name: z.string().trim().min(2).max(80),
  category: z.enum(HARDWARE_CATEGORIES),
  summary: z.string().trim().max(160),
  specs: bullets(8, 120),
  priceMinor,
  imageUrl,
  status: z.enum(HARDWARE_STATUSES),
  sortOrder: z.number().int().min(0).max(1000),
};

export const createHardwareItemSchema = z
  .object({
    slug,
    name: itemFields.name,
    category: itemFields.category,
    summary: itemFields.summary.optional(),
    specs: itemFields.specs.optional(),
    priceMinor: itemFields.priceMinor,
    imageUrl: itemFields.imageUrl.optional(),
    status: itemFields.status.optional(),
    sortOrder: itemFields.sortOrder.optional(),
  })
  .strict();

/** The slug is deliberately absent: it is the item's stable identity. */
export const updateHardwareItemSchema = z
  .object(itemFields)
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

const packageLines = z
  .array(z.object({ itemSlug: slug, quantity: z.number().int().min(1).max(99).default(1) }).strict())
  .max(12)
  .refine(
    (lines) => new Set(lines.map((line) => line.itemSlug)).size === lines.length,
    'Each item can only be listed once; use the quantity instead',
  );

const packageFields = {
  name: z.string().trim().min(2).max(80),
  tagline: z.string().trim().max(120),
  description: z.string().trim().max(600),
  items: packageLines,
  priceMinor,
  imageUrl,
  highlights: bullets(6, 60),
  bestFor: bullets(10, 40),
  featured: z.boolean(),
  status: z.enum(HARDWARE_STATUSES),
  sortOrder: z.number().int().min(0).max(1000),
};

export const createHardwarePackageSchema = z
  .object({
    slug,
    name: packageFields.name,
    tagline: packageFields.tagline.optional(),
    description: packageFields.description.optional(),
    items: packageFields.items,
    priceMinor: packageFields.priceMinor,
    imageUrl: packageFields.imageUrl.optional(),
    highlights: packageFields.highlights.optional(),
    bestFor: packageFields.bestFor.optional(),
    featured: packageFields.featured.optional(),
    status: packageFields.status.optional(),
    sortOrder: packageFields.sortOrder.optional(),
  })
  .strict();

export const updateHardwarePackageSchema = z
  .object(packageFields)
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');
