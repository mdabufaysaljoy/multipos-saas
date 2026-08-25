import { z } from 'zod';
import { searchSchema } from '../common/common.validators';

export const createCustomerSchema = z.object({
  name: z.string().trim().min(1, 'Customer name is required').max(160),
  phone: z.string().trim().min(3, 'Phone number is required').max(32),
  email: z.string().trim().toLowerCase().email('Enter a valid email').or(z.literal('')).optional().default(''),
  address: z.string().trim().max(400).optional().default(''),
  notes: z.string().trim().max(1000).optional().default(''),
});

export const updateCustomerSchema = createCustomerSchema.partial();

export const listCustomersSchema = searchSchema.extend({
  includeInactive: z.coerce.boolean().default(false),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type ListCustomersInput = z.infer<typeof listCustomersSchema>;
