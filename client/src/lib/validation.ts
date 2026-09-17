import { z } from 'zod';

/**
 * Client-side field rules, mirroring `server/src/modules/common/common.validators.ts`.
 *
 * These exist for the ERROR MESSAGE, not for safety. The server validates every
 * one of these again and is the only thing standing between a request and the
 * database - a form is a courtesy that tells someone what is wrong before they
 * submit, not a security control. Keep the two in step so the courtesy is
 * accurate.
 */

export const emailField = z
  .string()
  .trim()
  .min(1, 'Email is required')
  .max(254, 'Email address is too long')
  .email('Enter a valid email address');

export const optionalEmailField = z
  .union([z.literal(''), emailField])
  .optional()
  .default('');

export const phoneField = z
  .string()
  .trim()
  .max(32, 'Phone number is too long')
  .refine((value) => (value.match(/\d/g) ?? []).length >= 6, 'Enter a valid phone number')
  .refine((value) => /^[+()\-\s\d.]+$/.test(value), 'Use only digits, spaces and + ( ) - .');

export const optionalPhoneField = z.union([z.literal(''), phoneField]).optional().default('');

/** A password being SET. Checking one has a laxer rule. */
export const newPasswordField = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Password is too long');

/**
 * A whole count. `z.coerce.number()` alone turns '' into 0 and ' ' into 0,
 * which silently accepts an empty box as zero.
 */
export const wholeNumberField = (opts: { min?: number; max?: number; label?: string } = {}) => {
  const label = opts.label ?? 'Value';
  return z
    .union([z.number(), z.string()])
    .transform((value) => (typeof value === 'string' ? value.trim() : value))
    .refine((value) => value !== '' && value !== null && value !== undefined, `${label} is required`)
    .transform((value) => Number(value))
    .refine(Number.isFinite, `${label} must be a number`)
    .refine(Number.isInteger, `${label} must be a whole number`)
    .refine((value) => opts.min === undefined || value >= opts.min, `${label} must be at least ${opts.min}`)
    .refine((value) => opts.max === undefined || value <= opts.max, `${label} must be at most ${opts.max}`);
};

export const requiredText = (label: string, max = 200) =>
  z.string().trim().min(1, `${label} is required`).max(max, `${label} is too long`);

export const optionalText = (max = 500) => z.string().trim().max(max, 'This is too long').optional().default('');
