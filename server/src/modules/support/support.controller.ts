import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { getContext } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { ApiError } from '../../utils/ApiError';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { asyncHandler } from '../../utils/asyncHandler';
import { supportService } from './support.service';
import type { CreateTicketInput, ListAllTicketsInput, ListTicketsInput, ReplyTicketInput } from './support.validators';

/**
 * Thin, as everywhere: parse what the validator already checked, hand it to the
 * service, respond. No handler here reads a tenant id - the store-facing ones
 * take it from `getContext`, and the platform ones have none to read.
 */

// ------------------------------------------------------------------- the store

export const create = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const ticket = await supportService.create(ctx, body<CreateTicketInput>(req), { email: req.auth?.email ?? '' });
  // Who asked for what, so a disputed "we never reported this" has an answer.
  await recordAudit(req, {
    action: 'support.ticket.created',
    targetTenantId: ctx.tenantId,
    targetStoreId: ctx.storeId,
    targetLabel: `${ticket.reference} ${ticket.type}`,
  });
  created(res, ticket);
});

export const listMine = asyncHandler(async (req: Request, res: Response) => {
  const result = await supportService.listMine(getContext(req), query<ListTicketsInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const getMine = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await supportService.getMine(getContext(req), id));
});

// ---------------------------------------------------------- the platform admin

export const listAll = asyncHandler(async (req: Request, res: Response) => {
  const result = await supportService.listAll(query<ListAllTicketsInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const counts = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await supportService.counts());
});

export const getAny = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await supportService.getAny(id));
});

export const reply = asyncHandler(async (req: Request, res: Response) => {
  const admin = req.auth;
  if (!admin) throw ApiError.unauthorized();
  const { id } = params<{ id: Types.ObjectId }>(req);
  const input = body<ReplyTicketInput>(req);
  const ticket = await supportService.reply(id, input, { id: admin.id, name: admin.name });
  await recordAudit(req, {
    action: 'support.ticket.answered',
    targetTenantId: ticket.workspace.id as Types.ObjectId | null,
    targetLabel: ticket.reference,
    // The status it now carries and whether an answer was written - never the text.
    newValue: { status: ticket.status, replied: Boolean(input.reply) },
  });
  ok(res, ticket);
});
