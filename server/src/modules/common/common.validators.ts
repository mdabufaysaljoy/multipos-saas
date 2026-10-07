import { Types } from 'mongoose';
import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../config/constants';

/** Accepts a 24-char hex id and hands back a real ObjectId. */
export const objectId = z
  .string()
  .refine((value) => Types.ObjectId.isValid(value), { message: 'Invalid id' })
  .transform((value) => new Types.ObjectId(value));

export const idParam = z.object({ id: objectId });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const searchSchema = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  sort: z.string().trim().max(40).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * A whole, positive count. Rejects 1.5, "1e3", NaN and Infinity, which is the
 * backend half of the guarantee that a quantity can never become 0.001.
 */
export const positiveIntegerQuantity = z
  .number({ invalid_type_error: 'Quantity must be a number' })
  .refine(Number.isSafeInteger, { message: 'Quantity must be a whole number' })
  .refine((value) => value > 0, { message: 'Quantity must be at least 1' });

/** Same, but permits 0 - used where a draft value is legitimately zero. */
export const nonNegativeIntegerQuantity = z
  .number({ invalid_type_error: 'Quantity must be a number' })
  .refine(Number.isSafeInteger, { message: 'Quantity must be a whole number' })
  .refine((value) => value >= 0, { message: 'Quantity cannot be negative' });

/** Money in minor units. Always an integer; never a float. */
export const minorAmount = z
  .number({ invalid_type_error: 'Amount must be a number' })
  .refine(Number.isSafeInteger, { message: 'Amount must be a whole number of minor units' })
  .refine((value) => value >= 0, { message: 'Amount cannot be negative' });

export const positiveMinorAmount = minorAmount.refine((value) => value > 0, {
  message: 'Amount must be greater than zero',
});

// ---------------------------------------------------------------------------
// Shared field primitives
//
// Defined once so every module agrees on what a phone number, an email or a URL
// is. Before these existed the same field was spelled five different ways
// across the codebase, and each spelling had a different hole in it.
// ---------------------------------------------------------------------------

/** RFC 5321 caps an address at 254 characters; anything longer is not an email. */
export const emailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email address is too long')
  .email('Enter a valid email address');

/** An optional email that may legitimately be left blank. */
export const optionalEmailAddress = emailAddress.or(z.literal('')).optional().default('');

/**
 * A phone number: digits only.
 *
 * No +, brackets, dashes or spaces - a product decision, so the field can be a
 * plain number input and nothing but digits can ever be typed or stored. The
 * country code is written as digits ("8801700111222") rather than "+880".
 *
 * Seven is the shortest national number still in use; fifteen is the
 * international maximum under E.164. A dot was previously allowed, which meant
 * "01700.11122" was accepted - a phone number is not a decimal, and a field
 * that takes one is a field somebody will put a price in.
 *
 * Numbers stored before this carried formatting. Nothing rewrites them in
 * place, because a stored number is still a correct number; the phone input
 * strips them to digits when a record is opened, so the next save normalises
 * it rather than a migration touching rows nobody asked us to touch.
 */
export const PHONE_MIN_DIGITS = 7;
export const PHONE_MAX_DIGITS = 15;

export const phoneNumber = z
  .string()
  .trim()
  .refine((value) => /^\d+$/.test(value), {
    message: 'A phone number may contain digits only',
  })
  .refine((value) => value.length >= PHONE_MIN_DIGITS, {
    message: `Enter a complete phone number (at least ${PHONE_MIN_DIGITS} digits)`,
  })
  .refine((value) => value.length <= PHONE_MAX_DIGITS, {
    message: `A phone number cannot be longer than ${PHONE_MAX_DIGITS} digits`,
  });

/**
 * A person's name.
 *
 * Letters, spaces, and the three marks that appear inside real names: the
 * hyphen in "Rahman-Khan", the apostrophe in "O'Brien", and the dot in "Md."
 * - which is not a nicety here, it is how a very large share of the country
 * writes their own name.
 *
 * `\p{L}` rather than `A-Za-z`, so Bangla, Arabic and every other script is a
 * name too - and `\p{M}` with it, which is not optional: Bangla writes its
 * vowels as COMBINING MARKS, so "আবু ফয়সাল" is letters and marks interleaved
 * and a letters-only rule rejects most of the country's own names. Digits and
 * symbols are still refused: a person is not "Rahman123", and a name field
 * that accepts `<` is a name field somebody will put markup in.
 *
 * NOT for business, shop or supplier names. "A1 Traders" and "Shop 24/7" are
 * real trading names, and refusing them would be refusing the truth.
 */
export const personName = (what = 'Name') =>
  z
    .string()
    .trim()
    .min(2, `${what} is required`)
    .max(120, `${what} is too long`)
    .refine((value) => /^[\p{L}][\p{L}\p{M}\s'.-]*$/u.test(value), {
      message: `${what} may only contain letters, spaces and ' . -`,
    });

export const optionalPhoneNumber = phoneNumber.or(z.literal('')).optional().default('');

/**
 * A web URL.
 *
 * `z.string().url()` is not enough on its own: it accepts `javascript:`,
 * `data:text/html`, `vbscript:` and `file://`, because all of them parse as
 * valid URLs. Anywhere we store a URL it is later put in an `src` or followed
 * as a redirect, so the SCHEME is the part that matters.
 */
export const httpUrl = z
  .string()
  .trim()
  .max(2048, 'URL is too long')
  .url('Enter a valid URL')
  .refine((value) => {
    try {
      const scheme = new URL(value).protocol;
      return scheme === 'http:' || scheme === 'https:';
    } catch {
      return false;
    }
  }, { message: 'Only http and https URLs are allowed' });

export const optionalHttpUrl = httpUrl.nullable().optional();

/**
 * A password being CHECKED (not set).
 *
 * Bounded because bcrypt hashes whatever it is given: an unbounded field lets
 * one request burn CPU hashing a megabyte. Setting a password has its own,
 * stricter rule.
 */
export const passwordCheck = z.string().min(1, 'Password is required').max(128, 'Password is too long');

/**
 * A date supplied by a client, constrained to a sane calendar range.
 *
 * `z.coerce.date()` alone turns "0" into the year 2000 and accepts the year
 * 99999, which makes report ranges meaningless and forces needless index scans.
 */
export const calendarDate = z
  .preprocess((input) => {
    if (input instanceof Date) return input;
    if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(input)) {
      return new Date(Number.NaN);
    }

    const parsed = new Date(input.length === 10 ? `${input}T00:00:00.000Z` : input);
    // JavaScript normalises impossible date-only values such as 2026-02-30.
    // Refuse those instead of silently turning them into a different day.
    if (input.length === 10 && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) !== input) {
      return new Date(Number.NaN);
    }
    return parsed;
  }, z.date())
  .refine((value) => {
    const year = value.getUTCFullYear();
    return year >= 2000 && year <= 2100;
  }, { message: 'Enter a date between 2000 and 2100' });

/** Ensures a from/to pair is the right way round. */
export const assertOrderedRange = <T extends { from?: Date; to?: Date }>(value: T, ctx: z.RefinementCtx) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The start date must come before the end date', path: ['from'] });
  }
};

export const dateRangeSchema = z
  .object({
    from: calendarDate.optional(),
    to: calendarDate.optional(),
    preset: z.enum(['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'thisYear', 'custom']).optional(),
  })
  .superRefine(assertOrderedRange);

/**
 * A POS tender key: one of the six built-ins, or one a workspace defined.
 *
 * The shape is checked here; whether the branch actually takes it is checked by
 * the tender service, which is also what refuses a key nobody has defined.
 */
export const paymentMethodKey = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'Choose a payment method')
  .max(24)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'A payment method key uses letters, numbers, - and _');
