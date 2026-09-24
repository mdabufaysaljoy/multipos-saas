import { z } from 'zod';
import { searchSchema, phoneNumber, optionalEmailAddress } from '../common/common.validators';

export const createCustomerSchema = z
  .object({
    name: z.string().trim().min(1, 'Customer name is required').max(160),
    phone: phoneNumber,
    email: optionalEmailAddress,
    address: z.string().trim().max(400).optional().default(''),
    notes: z.string().trim().max(1000).optional().default(''),
  })
  // A workspace, branch or owner named in the body is refused, not ignored.
  .strict();

/**
 * A customer typed at the till, in any POS vertical: the sale endpoint finds
 * them by phone or creates them in one step, so a cashier never has to leave
 * the checkout. Every vertical accepts the same shape alongside `customerId`.
 */
export const posCustomerSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    phone: phoneNumber,
    email: optionalEmailAddress,
  })
  .strict();

export const updateCustomerSchema = createCustomerSchema.partial();

export const listCustomersSchema = searchSchema.extend({
  includeInactive: z.coerce.boolean().default(false),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type ListCustomersInput = z.infer<typeof listCustomersSchema>;
