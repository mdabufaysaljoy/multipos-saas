import { z } from 'zod';
import { PAYMENT_TERMS, SUPPLIER_TYPES } from '../../models/Supplier';
import { searchSchema } from '../common/common.validators';

/**
 * Supplier input.
 *
 * Only the name is required: this is a contact book, and a merchant must be
 * able to save "ABC Garments, phone number to follow" without inventing data.
 * Ownership is never accepted from the client - no tenant, store or code field
 * exists here, because the server assigns all three.
 */

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).optional().default('');

/**
 * A phone as typed. Digits, spaces and the usual punctuation, 4-32 characters -
 * the same permissive rule the rest of the app uses, because the SaaS is not
 * limited to Bangladeshi numbers.
 */
const phone = z
  .string()
  .trim()
  .max(32)
  .refine((value) => value === '' || /^[+()\d][\d\s\-().]{3,}$/.test(value), { message: 'Enter a valid phone number' })
  .optional()
  .default('');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .refine((value) => value === '' || z.string().email().safeParse(value).success, { message: 'Enter a valid email address' })
  .optional()
  .default('');

/** A website is stored and shown, never fetched: no request is ever made to it. */
const website = z
  .string()
  .trim()
  .max(300)
  .refine(
    (value) => {
      if (value === '') return true;
      try {
        const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
        return Boolean(url.hostname) && url.hostname.includes('.');
      } catch {
        return false;
      }
    },
    { message: 'Enter a valid website address' },
  )
  .optional()
  .default('');

const addressSchema = z
  .object({
    line1: optionalText(200),
    line2: optionalText(200),
    area: optionalText(120),
    city: optionalText(120),
    district: optionalText(120),
    division: optionalText(120),
    postalCode: text(16)
      .refine((value) => value === '' || /^[A-Za-z0-9][A-Za-z0-9 -]{1,15}$/.test(value), { message: 'Enter a valid postal code' })
      .optional()
      .default(''),
    country: optionalText(80),
  })
  .strict();

const contactSchema = z
  .object({
    name: optionalText(160),
    designation: optionalText(120),
    phone,
    altPhone: phone,
    email,
  })
  .strict();

const bankingSchema = z
  .object({
    accountName: optionalText(160),
    accountNumber: text(64)
      .refine((value) => value === '' || /^[A-Za-z0-9 -]{4,64}$/.test(value), { message: 'Enter a valid account number' })
      .optional()
      .default(''),
    bankName: optionalText(160),
    branchName: optionalText(160),
  })
  .strict();

export const createSupplierSchema = z
  .object({
    name: z.string().trim().min(1, 'Supplier name is required').max(160),
    type: z.enum(SUPPLIER_TYPES).default('other'),
    contact: contactSchema.optional().default({}),
    phone,
    email,
    website,
    address: addressSchema.optional().default({}),
    taxNumber: optionalText(64),
    tradeLicense: optionalText(64),
    banking: bankingSchema.optional().default({}),
    paymentTerms: z.enum(PAYMENT_TERMS).default('cash'),
    paymentTermsNote: optionalText(120),
    notes: z.string().trim().max(2000).optional().default(''),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateSupplierSchema = createSupplierSchema.partial();

export const listSuppliersSchema = searchSchema.extend({
  status: z.enum(['all', 'active', 'inactive']).default('all'),
  type: z.enum(SUPPLIER_TYPES).optional(),
});

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
export type ListSuppliersInput = z.infer<typeof listSuppliersSchema>;
