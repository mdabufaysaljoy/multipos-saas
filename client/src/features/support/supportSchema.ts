import { z } from 'zod';

/**
 * The support form's rules, mirroring `server/src/modules/support/support.validators.ts`.
 *
 * Same fields, same limits, same messages, so the form says exactly what the
 * server would have said. As everywhere in `lib/validation.ts`, this is for the
 * error message - the server validates the request again and is the only thing
 * that decides whether a ticket is stored.
 */

const prose = (what: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${what} is required`)
    .max(max, `${what} is too long`)
    .refine((value) => !/[<>]/.test(value), { message: `${what} cannot contain < or >` });

export const SUPPORT_TICKET_TYPES = ['problem', 'feature'] as const;

export const SUPPORT_AREAS = [
  'pos',
  'catalogue',
  'inventory',
  'customers',
  'reports',
  'printing',
  'billing',
  'staff',
  'other',
] as const;

export const createTicketSchema = z.object({
  type: z.enum(SUPPORT_TICKET_TYPES, { required_error: 'Choose what this is about' }),
  area: z.enum(SUPPORT_AREAS),
  subject: prose('A subject', 140).refine((value) => value.length >= 5, { message: 'Give the subject a few more words' }),
  message: prose('A description', 4000).refine((value) => value.length >= 20, {
    message: 'Describe it in at least 20 characters so the team can act on it',
  }),
});

export type CreateTicketValues = z.infer<typeof createTicketSchema>;

/** The words the UI puts to each stored value. One place, both sides of support. */
export const SUPPORT_TYPE_LABELS: Record<string, string> = {
  problem: 'Problem report',
  feature: 'Feature request',
};

export const SUPPORT_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const SUPPORT_AREA_LABELS: Record<string, string> = {
  pos: 'Point of sale',
  catalogue: 'Products & catalogue',
  inventory: 'Inventory & stock',
  customers: 'Customers & loyalty',
  reports: 'Reports & analytics',
  printing: 'Printing & receipts',
  billing: 'Billing & subscription',
  staff: 'Staff & roles',
  other: 'Something else',
};
