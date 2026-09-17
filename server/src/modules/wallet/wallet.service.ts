import { TenantModel } from '../../models/Tenant';
import { issueReceiptSafely, presentTopUps } from '../../services/billing/receipt.service';
import { Types } from 'mongoose';
import { TopUpRequestModel, type TopUpRequestDoc } from '../../models/TopUpRequest';
import { getPlatformSettings } from '../../models/PlatformSettings';
import { ApiError } from '../../utils/ApiError';
import { resolvePage } from '../../utils/pagination';
import { walletService } from '../../services/wallet/wallet.service';
import type { TenantContext } from '../../types/express';
import type { ManualAdjustmentInput, TopUpRequestInput } from './wallet.validators';

interface Actor {
  id: Types.ObjectId | null;
  name: string;
}

/** The workspace a top-up is for, and who is acting: a workspace session, or the account owner from Billing. */
export type TopUpActor = Pick<TenantContext, 'tenantId' | 'userId' | 'userName'>;

class TopUpService {
  /**
   * Files a top-up claim. The balance is untouched until a platform admin
   * verifies the transaction - a customer saying they paid is not payment.
   */
  async submit(ctx: TopUpActor, input: TopUpRequestInput) {
    const pending = await TopUpRequestModel.countDocuments({ tenantId: ctx.tenantId, status: 'pending' });
    if (pending >= 3) {
      throw ApiError.conflict('You already have several top-up requests awaiting review.');
    }

    const duplicate = await TopUpRequestModel.findOne({ transactionId: input.transactionId.trim() }).lean();
    if (duplicate) throw ApiError.conflict('That transaction ID has already been submitted.');

    const settings = await getPlatformSettings();

    const request = await TopUpRequestModel.create({
      tenantId: ctx.tenantId,
      requestedBy: ctx.userId,
      requestedByNameSnapshot: ctx.userName,
      amountMinor: input.amountMinor,
      currency: settings.currency,
      paymentMethod: input.paymentMethod,
      senderNumber: input.senderNumber,
      transactionId: input.transactionId.trim(),
      note: input.note,
      status: 'pending',
    });

    return request.toObject();
  }

  async listForTenant(tenantId: Types.ObjectId, input: { page?: number; limit?: number }) {
    const { page, limit, skip } = resolvePage(input);
    const [items, total] = await Promise.all([
      TopUpRequestModel.find({ tenantId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean<(TopUpRequestDoc & { _id: Types.ObjectId })[]>(),
      TopUpRequestModel.countDocuments({ tenantId }),
    ]);
    // Without who reviewed it internally; with its receipt number once approved.
    return { items: await presentTopUps(items), page, limit, total };
  }

  async cancel(ctx: TopUpActor, id: Types.ObjectId) {
    // Atomic: a cancellation can never overwrite an approval (and its credit) made at the same moment.
    const request = await TopUpRequestModel.findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, status: 'pending' },
      { $set: { status: 'cancelled' } },
      { new: true },
    ).lean<TopUpRequestDoc & { _id: Types.ObjectId }>();
    if (!request) {
      const existing = await TopUpRequestModel.findOne({ _id: id, tenantId: ctx.tenantId }).select('status').lean();
      if (!existing) throw ApiError.notFound('Request not found');
      throw ApiError.badRequest('Only a pending request can be cancelled');
    }
    return (await presentTopUps([request]))[0];
  }

  /** Top-ups across several workspaces (the account owner's), newest first, with workspace names. */
  async listForWorkspaces(tenantIds: Types.ObjectId[], input: { page?: number; limit?: number; status?: string }) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { tenantId: { $in: tenantIds } };
    if (input.status) filter.status = input.status;
    const [items, total, workspaces] = await Promise.all([
      TopUpRequestModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean<(TopUpRequestDoc & { _id: Types.ObjectId })[]>(),
      TopUpRequestModel.countDocuments(filter),
      TenantModel.find({ _id: { $in: tenantIds } }).select('name').lean(),
    ]);
    const names = new Map(workspaces.map((workspace) => [String(workspace._id), workspace.name]));
    const presented = await presentTopUps(items);
    return { items: presented.map((topUp) => ({ ...topUp, workspaceName: names.get(String(topUp.workspaceId)) ?? null })), page, limit, total };
  }

  // -------------------------------------------------------- platform admin

  async listAll(input: { page?: number; limit?: number; status?: string }) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = {};
    if (input.status) filter.status = input.status;

    const [items, total] = await Promise.all([
      TopUpRequestModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('tenantId', 'name slug contactEmail contactPhone')
        .lean(),
      TopUpRequestModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  /** The only path that turns a claimed payment into wallet balance. */
  async approve(id: Types.ObjectId, actor: Actor, reviewNote: string) {
    // Atomic claim: of any number of concurrent approvals (two admins, a double
    // click, a retried request) exactly one moves from pending and credits the
    // wallet. Previously two could both pass a read-then-check and credit twice.
    const request = await TopUpRequestModel.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'approved', reviewedBy: actor.id, reviewedByNameSnapshot: actor.name, reviewedAt: new Date(), reviewNote } },
      { new: true },
    );
    if (!request) {
      const existing = await TopUpRequestModel.findById(id).select('status').lean();
      if (!existing) throw ApiError.notFound('Request not found');
      throw ApiError.badRequest(`This request is already ${existing.status}`);
    }

    let result;
    try {
      result = await walletService.credit(request.tenantId, {
        amountMinor: request.amountMinor,
        reason: `Wallet top-up via ${request.paymentMethod} (${request.transactionId})`,
        referenceType: 'topup',
        referenceId: request._id,
        performedBy: actor.id,
        performedByName: actor.name,
        metadata: { transactionId: request.transactionId, method: request.paymentMethod },
      });
    } catch (error) {
      // Nothing was credited: the request goes back for review.
      await TopUpRequestModel.updateOne(
        { _id: request._id, status: 'approved', walletTransactionId: null },
        { $set: { status: 'pending', reviewedBy: null, reviewedByNameSnapshot: '', reviewedAt: null, reviewNote: '' } },
      );
      throw error;
    }

    await TopUpRequestModel.updateOne({ _id: request._id }, { $set: { walletTransactionId: result.transaction._id } });
    request.walletTransactionId = result.transaction._id;
    const receipt = await issueReceiptSafely(request._id);

    return { request: request.toObject(), balanceMinor: result.balanceMinor, receipt: receipt ? { id: receipt._id, number: receipt.number } : null };
  }

  async reject(id: Types.ObjectId, actor: Actor, reviewNote: string) {
    // Atomic, so a rejection can never overwrite an approval made at the same moment.
    const request = await TopUpRequestModel.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'rejected', reviewedBy: actor.id, reviewedByNameSnapshot: actor.name, reviewedAt: new Date(), reviewNote } },
      { new: true },
    ).lean();
    if (!request) {
      const existing = await TopUpRequestModel.findById(id).select('status').lean();
      if (!existing) throw ApiError.notFound('Request not found');
      throw ApiError.badRequest(`This request is already ${existing.status}`);
    }
    return request;
  }

  /** Manual credit/debit by a platform admin, always with a stated reason. */
  async adjust(tenantId: Types.ObjectId, input: ManualAdjustmentInput, actor: Actor) {
    const movement = { amountMinor: input.amountMinor, reason: input.reason, referenceType: 'adjustment' as const, performedBy: actor.id, performedByName: actor.name };
    return input.direction === 'credit'
      ? walletService.credit(tenantId, movement, 'adjustment')
      : walletService.debit(tenantId, movement);
  }
}

export const topUpService = new TopUpService();
