import { z } from 'zod';
import {
  SUPPORT_TICKET_AREAS,
  SUPPORT_TICKET_STATUSES,
  SUPPORT_TICKET_TYPES,
} from '../../models/SupportTicket';
import { objectId, paginationSchema } from '../common/common.validators';

/**
 * A ticket is free text a stranger typed, so the rules here are about shape and
 * size only - the service is what strips markup out of it. Everything a client
 * could use to address another workspace's data is absent by design: there is
 * no tenantId in any schema on this surface.
 */

/**
 * Plain prose. No angle brackets and no `&...;` entities, so nothing stored can
 * come back out as markup wherever it is later rendered - an email to the
 * operator, a platform screen, a report. Refusing them at the edge is clearer
 * to the person typing than silently rewriting what they wrote, and `<` in a
 * sentence about a problem is almost always a pasted tag.
 */
const prose = (what: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${what} is required`)
    .max(max, `${what} is too long`)
    .refine((value) => !/[<>]/.test(value), { message: `${what} cannot contain < or >` });

export const createTicketSchema = z
  .object({
    type: z.enum(SUPPORT_TICKET_TYPES, { required_error: 'Choose what this is about' }),
    area: z.enum(SUPPORT_TICKET_AREAS).optional().default('other'),
    subject: prose('A subject', 140).refine((value) => value.length >= 5, { message: 'Give the subject a few more words' }),
    message: prose('A description', 4000).refine((value) => value.length >= 20, {
      message: 'Describe it in at least 20 characters so the team can act on it',
    }),
  })
  .strict();

export const listTicketsSchema = paginationSchema.extend({
  status: z.enum(SUPPORT_TICKET_STATUSES).optional(),
  type: z.enum(SUPPORT_TICKET_TYPES).optional(),
});

/** The platform inbox can also narrow to one workspace. */
export const listAllTicketsSchema = listTicketsSchema.extend({
  tenantId: objectId.optional(),
  search: z.string().trim().max(140).optional(),
});

/**
 * The operator's answer. The reply may be left out when the admin only moves
 * the status - closing a duplicate, say - but a status is always required, so
 * no ticket is silently answered and left looking unattended.
 */
export const replyTicketSchema = z
  .object({
    status: z.enum(SUPPORT_TICKET_STATUSES),
    reply: prose('A reply', 4000).optional(),
  })
  .strict();

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type ListTicketsInput = z.infer<typeof listTicketsSchema>;
export type ListAllTicketsInput = z.infer<typeof listAllTicketsSchema>;
export type ReplyTicketInput = z.infer<typeof replyTicketSchema>;
