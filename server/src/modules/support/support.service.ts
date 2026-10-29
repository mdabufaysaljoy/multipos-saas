import type { Types } from 'mongoose';
import { SupportTicketModel, type SupportTicketDoc } from '../../models/SupportTicket';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextTenantSequence } from '../../utils/counters';
import { resolvePage, searchRegex } from '../../utils/pagination';
import type { TenantContext } from '../../types/express';
import type { CreateTicketInput, ListAllTicketsInput, ListTicketsInput, ReplyTicketInput } from './support.validators';

/**
 * Support tickets: a store asking the platform operator for something.
 *
 * TWO CALLERS, TWO SCOPES, ONE PLACE. The store-facing methods take a
 * `TenantContext` and every query they build starts from `ctx.tenantId`, which
 * `resolveTenant` took from the signed-in user and nothing else - so a store
 * cannot read, list or reply to a ticket belonging to another workspace
 * whatever it puts in the URL. The platform methods take no tenant at all and
 * are mounted behind `requirePlatformAdmin`. The two are separate methods on
 * purpose: a shared one with an optional tenant filter is exactly the shape
 * where a forgotten argument becomes a cross-tenant read.
 */

const TICKET_PREFIX = 'TKT-';
const MAX_REFERENCE_ATTEMPTS = 5;

/** What a store is shown. Who answered is a person; the store is told the team answered. */
const presentForStore = (ticket: SupportTicketDoc | (SupportTicketDoc & { _id: Types.ObjectId })) => ({
  _id: ticket._id,
  reference: ticket.reference,
  type: ticket.type,
  status: ticket.status,
  area: ticket.area,
  subject: ticket.subject,
  message: ticket.message,
  createdByName: ticket.createdByName,
  reply: ticket.reply,
  repliedAt: ticket.repliedAt,
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
});

class SupportService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId };
  }

  // ---------------------------------------------------------------- the store

  async create(ctx: TenantContext, input: CreateTicketInput, author: { email: string }) {
    const ticket = await this.insertWithReference(ctx, input, author);
    return presentForStore(ticket);
  }

  async listMine(ctx: TenantContext, input: ListTicketsInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { ...this.scope(ctx) };
    if (input.status) filter.status = input.status;
    if (input.type) filter.type = input.type;

    const [items, total] = await Promise.all([
      SupportTicketModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      SupportTicketModel.countDocuments(filter),
    ]);

    return { items: items.map(presentForStore), page, limit, total };
  }

  async getMine(ctx: TenantContext, id: Types.ObjectId) {
    // The tenant is part of the LOOKUP, not a check afterwards: another
    // workspace's id is simply not found here, which is also the right answer
    // to give - it tells the caller nothing about what exists elsewhere.
    const ticket = await SupportTicketModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!ticket) throw ApiError.notFound('Ticket not found');
    return presentForStore(ticket);
  }

  // ------------------------------------------------------- the platform admin

  async listAll(input: ListAllTicketsInput) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = {};
    if (input.status) filter.status = input.status;
    if (input.type) filter.type = input.type;
    if (input.tenantId) filter.tenantId = input.tenantId;
    if (input.search) {
      const rx = searchRegex(input.search);
      filter.$or = [{ reference: rx }, { subject: rx }];
    }

    const [items, total] = await Promise.all([
      SupportTicketModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate<{ tenantId: { _id: Types.ObjectId; name: string } | null }>('tenantId', 'name')
        .lean(),
      SupportTicketModel.countDocuments(filter),
    ]);

    return { items: items.map(this.presentForPlatform), page, limit, total };
  }

  async getAny(id: Types.ObjectId) {
    const ticket = await SupportTicketModel.findById(id)
      .populate<{ tenantId: { _id: Types.ObjectId; name: string } | null }>('tenantId', 'name')
      .lean();
    if (!ticket) throw ApiError.notFound('Ticket not found');
    return this.presentForPlatform(ticket);
  }

  /** The operator answers and sets where the ticket now stands, in one write. */
  async reply(id: Types.ObjectId, input: ReplyTicketInput, admin: { id: Types.ObjectId; name: string }) {
    const ticket = await SupportTicketModel.findById(id);
    if (!ticket) throw ApiError.notFound('Ticket not found');

    ticket.status = input.status;
    // An empty reply is a status change only; it must not erase an answer the
    // store has already read.
    if (input.reply) {
      ticket.reply = input.reply;
      ticket.repliedAt = new Date();
      ticket.repliedBy = admin.id;
      ticket.repliedByName = admin.name;
    }
    await ticket.save();

    return this.getAny(ticket._id);
  }

  async counts() {
    const rows = await SupportTicketModel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const byStatus = Object.fromEntries(rows.map((row) => [row._id, row.count]));
    return {
      open: byStatus.open ?? 0,
      inProgress: byStatus.in_progress ?? 0,
      resolved: byStatus.resolved ?? 0,
      closed: byStatus.closed ?? 0,
    };
  }

  // ------------------------------------------------------------------ private

  /** The operator sees who wrote it and which workspace it came from. */
  private presentForPlatform = (ticket: {
    _id: Types.ObjectId;
    tenantId: { _id: Types.ObjectId; name: string } | Types.ObjectId | null;
    reference: string;
    type: string;
    status: string;
    area: string;
    subject: string;
    message: string;
    vertical: string;
    createdByName: string;
    createdByEmail: string;
    reply: string;
    repliedAt: Date | null;
    repliedByName: string;
    createdAt: Date;
    updatedAt: Date;
  }) => {
    const tenant = ticket.tenantId && 'name' in ticket.tenantId ? ticket.tenantId : null;
    return {
      _id: ticket._id,
      reference: ticket.reference,
      type: ticket.type,
      status: ticket.status,
      area: ticket.area,
      subject: ticket.subject,
      message: ticket.message,
      vertical: ticket.vertical,
      workspace: {
        id: tenant?._id ?? ticket.tenantId ?? null,
        name: tenant?.name ?? 'Unknown workspace',
      },
      createdByName: ticket.createdByName,
      createdByEmail: ticket.createdByEmail,
      reply: ticket.reply,
      repliedAt: ticket.repliedAt,
      repliedByName: ticket.repliedByName,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    };
  };

  /**
   * References come from an atomic per-workspace counter, so two tills filing
   * at the same moment get TKT-000012 and TKT-000013. The retry exists for the
   * one case the counter cannot cover: a workspace whose counter was reset or
   * restored behind an existing ticket.
   */
  private async insertWithReference(ctx: TenantContext, input: CreateTicketInput, author: { email: string }) {
    for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt += 1) {
      const seq = await nextTenantSequence(ctx.tenantId, 'supportTicket');
      try {
        return await SupportTicketModel.create({
          tenantId: ctx.tenantId,
          storeId: ctx.storeId,
          reference: formatDocumentNumber(TICKET_PREFIX, seq),
          type: input.type,
          area: input.area,
          status: 'open',
          subject: input.subject,
          message: input.message,
          vertical: ctx.vertical,
          createdBy: ctx.userId,
          createdByName: ctx.userName,
          createdByEmail: author.email,
        });
      } catch (error) {
        if (!isDuplicateKey(error) || attempt === MAX_REFERENCE_ATTEMPTS - 1) throw error;
      }
    }
    throw ApiError.internal('Could not allocate a ticket reference');
  }
}

const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;

export const supportService = new SupportService();
