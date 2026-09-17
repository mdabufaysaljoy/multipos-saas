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
 * A phone number.
 *
 * Deliberately permissive about punctuation - people write +880, spaces and
 * dashes - but it must contain a plausible run of DIGITS. The previous
 * `z.string().max(32)` accepted "abcdefghij" and "<script>x" as phone numbers.
 */
export const phoneNumber = z
  .string()
  .trim()
  .max(32, 'Phone number is too long')
  .refine((value) => (value.match(/\d/g) ?? []).length >= 6, {
    message: 'Enter a valid phone number',
  })
  .refine((value) => /^[+()\-\s\d.]+$/.test(value), {
    message: 'A phone number may only contain digits, spaces and + ( ) - .',
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
export const calendarDate = z.coerce
  .date()
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
