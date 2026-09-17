import { Types } from 'mongoose';
import { AccountModel } from '../../models/Account';
import { USAGE_SERVICES, UsageChargeModel, type UsageService } from '../../models/UsageCharge';
import { WalletTransactionModel } from '../../models/WalletTransaction';
import { ApiError } from '../../utils/ApiError';
import { resolvePage } from '../../utils/pagination';
import { walletService, type LedgerViewer } from '../wallet/wallet.service';
import { USAGE_UNITS, unitPriceMinor } from './usagePricing';

export interface ChargeActor {
  /** The workspace using the service. The wallet is resolved from it. */
  tenantId: Types.ObjectId;
  userId?: Types.ObjectId | null;
  userName?: string;
}

export interface ChargeInput {
  service: UsageService;
  quantity: number;
  description: string;
  referenceType?: string | null;
  referenceId?: Types.ObjectId | null;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;
const MAX_QUANTITY = 10_000_000;

/**
 * THE way a paid platform service is billed.
 *
 * Prices are read on the server at the moment of use and frozen on the charge;
 * the caller only says what was used and how much. Money moves only through
 * `walletService`, so the wallet ledger stays the single record of balance.
 *
 *   charge  - pending record, then one wallet debit, then `charged`
 *   refund  - an atomic claim against the refundable remainder, so concurrent
 *             refunds can never return more than was charged; then one credit
 *   reconcile - finishes anything an interrupted process left half-done
 */
class UsageChargeService {
  async quote(service: UsageService, quantity: number) {
    if (!USAGE_SERVICES.includes(service)) throw ApiError.badRequest('Unknown usage service');
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
      throw ApiError.badRequest('Usage quantity must be a positive whole number');
    }
    const price = await unitPriceMinor(service);
    const amountMinor = price * quantity;
    if (!Number.isSafeInteger(amountMinor)) throw ApiError.badRequest('That usage is too large to bill in one charge');
    return { service, unit: USAGE_UNITS[service].unit, quantity, unitPriceMinor: price, amountMinor };
  }

  async charge(actor: ChargeActor, input: ChargeInput) {
    if (input.idempotencyKey) {
      const existing = await UsageChargeModel.findOne({ idempotencyKey: input.idempotencyKey }).lean();
      if (existing) {
        // A key belongs to the workspace that first used it.
        if (!existing.tenantId.equals(actor.tenantId)) throw ApiError.conflict('That idempotency key has already been used');
        return existing;
      }
    }

    const quote = await this.quote(input.service, input.quantity);
    const wallet = await walletService.getOrCreate(actor.tenantId);
    const free = quote.amountMinor === 0;

    let chargeId: Types.ObjectId;
    try {
      const created = await UsageChargeModel.create({
        accountId: wallet.accountId ?? null,
        tenantId: actor.tenantId,
        walletId: wallet._id,
        service: quote.service,
        unit: quote.unit,
        quantity: quote.quantity,
        unitPriceMinor: quote.unitPriceMinor,
        amountMinor: quote.amountMinor,
        refundedMinor: 0,
        currency: wallet.currency,
        // A free use is still recorded as usage, with no money moved.
        status: free ? 'charged' : 'pending',
        description: input.description.slice(0, 300),
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        performedBy: actor.userId ?? null,
        performedByNameSnapshot: actor.userName ?? 'system',
        metadata: input.metadata ?? {},
      });
      chargeId = created._id;
      if (free) return created.toObject();
    } catch (error) {
      // Two identical retries raced; the other one owns the charge.
      if (isDuplicateKey(error) && input.idempotencyKey) {
        const winner = await UsageChargeModel.findOne({ idempotencyKey: input.idempotencyKey }).lean();
        if (winner && winner.tenantId.equals(actor.tenantId)) return winner;
        throw ApiError.conflict('That idempotency key has already been used');
      }
      throw error;
    }

    try {
      const movement = await walletService.debit(actor.tenantId, {
        amountMinor: quote.amountMinor,
        reason: input.description.slice(0, 300),
        referenceType: quote.service,
        referenceId: chargeId,
        performedBy: actor.userId ?? null,
        performedByName: actor.userName,
        metadata: {
          usageChargeId: chargeId,
          quantity: quote.quantity,
          unitPriceMinor: quote.unitPriceMinor,
          ...(input.referenceType ? { usageReferenceType: input.referenceType, usageReferenceId: input.referenceId } : {}),
        },
      });
      const charged = await UsageChargeModel.findOneAndUpdate(
        { _id: chargeId, status: 'pending' },
        { $set: { status: 'charged', debitTransactionId: movement.transaction._id } },
        { new: true },
      ).lean();
      return charged ?? (await UsageChargeModel.findById(chargeId).lean())!;
    } catch (error) {
      await UsageChargeModel.updateOne(
        { _id: chargeId, status: 'pending' },
        { $set: { status: 'failed', failureReason: error instanceof Error ? error.message.slice(0, 300) : 'The charge failed' } },
      );
      throw error;
    }
  }

  /** Returns part or all of a charge to the wallet it was paid from. */
  async refund(chargeId: Types.ObjectId, amountMinor: number, reason: string, actor: Omit<ChargeActor, 'tenantId'> = {}) {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw ApiError.badRequest('A refund must be a positive whole number of minor units');
    }

    const refundId = new Types.ObjectId();
    // The claim IS the guard: it only matches while the remainder covers this
    // amount, so any number of concurrent refunds total at most the charge.
    const claimed = await UsageChargeModel.findOneAndUpdate(
      {
        _id: chargeId,
        status: { $in: ['charged', 'partially_refunded'] },
        $expr: { $lte: [{ $add: ['$refundedMinor', amountMinor] }, '$amountMinor'] },
      },
      {
        $inc: { refundedMinor: amountMinor },
        $push: {
          refunds: { refundId, amountMinor, reason: reason.slice(0, 300), status: 'pending', walletTransactionId: null, createdAt: new Date() },
        },
      },
      { new: true },
    ).lean();
    if (!claimed) throw ApiError.conflict('This charge cannot be refunded by that amount');

    await this.completeRefund(chargeId, refundId, actor);
    return (await UsageChargeModel.findById(chargeId).lean())!;
  }

  /**
   * Finishes charges and refunds an interrupted process left half-done.
   * Anything younger than `olderThanMs` is assumed to still be in flight.
   */
  async reconcile(olderThanMs = 15 * 60 * 1000) {
    const cutoff = new Date(Date.now() - olderThanMs);
    let chargesSettled = 0;
    let chargesFailed = 0;
    let refundsCompleted = 0;

    const pending = await UsageChargeModel.find({ status: 'pending', createdAt: { $lt: cutoff } }).select('_id').lean();
    for (const { _id } of pending) {
      // The debit carries the charge id, so its ledger row proves it landed.
      const debit = await WalletTransactionModel.findOne({ referenceId: _id, type: 'debit' }).select('_id').lean();
      const result = await UsageChargeModel.updateOne(
        { _id, status: 'pending' },
        debit
          ? { $set: { status: 'charged', debitTransactionId: debit._id } }
          : { $set: { status: 'failed', failureReason: 'Interrupted before the wallet was debited' } },
      );
      if (result.modifiedCount > 0) {
        if (debit) chargesSettled += 1;
        else chargesFailed += 1;
      }
    }

    const withRefunds = await UsageChargeModel.find({
      refunds: { $elemMatch: { status: { $in: ['pending', 'crediting'] }, createdAt: { $lt: cutoff } } },
    })
      .select('_id refunds')
      .lean();
    for (const charge of withRefunds) {
      for (const entry of charge.refunds) {
        if (entry.status === 'completed' || entry.createdAt >= cutoff) continue;
        if (await this.completeRefund(charge._id, entry.refundId, {}, true)) refundsCompleted += 1;
      }
    }

    return { chargesSettled, chargesFailed, refundsCompleted };
  }

  /**
   * Account-wide for the account owner, own workspace for everyone else - the
   * same visibility rule as the wallet ledger.
   */
  async list(
    tenantId: Types.ObjectId,
    input: { page?: number; limit?: number; service?: UsageService; from?: Date; to?: Date },
    viewer?: LedgerViewer,
  ) {
    const { page, limit, skip } = resolvePage(input);
    const wallet = await walletService.getOrCreate(tenantId);

    const filter: Record<string, unknown> = wallet.accountId ? { accountId: wallet.accountId } : { tenantId };
    if (viewer && wallet.accountId) {
      const account = await AccountModel.findById(wallet.accountId).select('ownerUserId').lean();
      if (!account || !account.ownerUserId.equals(viewer.userId)) filter.tenantId = tenantId;
    }
    if (input.service) filter.service = input.service;
    if (input.from || input.to) {
      filter.createdAt = { ...(input.from ? { $gte: input.from } : {}), ...(input.to ? { $lte: input.to } : {}) };
    }

    const billed = { ...filter, status: { $in: ['charged', 'partially_refunded', 'refunded'] } };
    const [items, total, rows] = await Promise.all([
      UsageChargeModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-idempotencyKey -refunds.refundId')
        .lean(),
      UsageChargeModel.countDocuments(filter),
      UsageChargeModel.aggregate<{ _id: string; quantity: number; chargedMinor: number; refundedMinor: number; count: number }>([
        { $match: billed },
        {
          $group: {
            _id: '$service',
            quantity: { $sum: '$quantity' },
            chargedMinor: { $sum: '$amountMinor' },
            refundedMinor: { $sum: '$refundedMinor' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const summary = USAGE_SERVICES.map((service) => {
      const row = rows.find((r) => r._id === service);
      return {
        service,
        label: USAGE_UNITS[service].label,
        unit: USAGE_UNITS[service].unit,
        charges: row?.count ?? 0,
        quantity: row?.quantity ?? 0,
        chargedMinor: row?.chargedMinor ?? 0,
        refundedMinor: row?.refundedMinor ?? 0,
        netMinor: (row?.chargedMinor ?? 0) - (row?.refundedMinor ?? 0),
      };
    });

    return { items, page, limit, total, summary };
  }

  /**
   * Credits one refund exactly once. Moving the entry to `crediting` is an
   * atomic claim, so two callers cannot both credit it. A `crediting` entry
   * found later by the reconciler is resolved against the ledger: the credit
   * carries the refund id, so an existing row means it already landed.
   */
  private async completeRefund(
    chargeId: Types.ObjectId,
    refundId: Types.ObjectId,
    actor: Omit<ChargeActor, 'tenantId'>,
    recovering = false,
  ): Promise<boolean> {
    const claimed = await UsageChargeModel.findOneAndUpdate(
      { _id: chargeId, refunds: { $elemMatch: { refundId, status: 'pending' } } },
      { $set: { 'refunds.$.status': 'crediting' } },
      { new: true },
    ).lean();

    const charge = claimed ?? (recovering ? await UsageChargeModel.findById(chargeId).lean() : null);
    const entry = charge?.refunds.find((r) => r.refundId.equals(refundId));
    if (!charge || !entry || entry.status === 'completed') return false;
    // Not recovering and not the winner of the claim: someone else is crediting.
    if (!claimed && entry.status !== 'crediting') return false;

    let transactionId = (await WalletTransactionModel.findOne({ referenceId: refundId, type: 'refund' }).select('_id').lean())?._id;
    if (!transactionId) {
      const movement = await walletService.credit(
        charge.tenantId,
        {
          amountMinor: entry.amountMinor,
          reason: entry.reason,
          referenceType: charge.service,
          referenceId: refundId,
          performedBy: actor.userId ?? null,
          performedByName: actor.userName,
          metadata: { usageChargeId: charge._id },
        },
        'refund',
      );
      transactionId = movement.transaction._id;
    }

    await UsageChargeModel.updateOne(
      { _id: chargeId, 'refunds.refundId': refundId },
      { $set: { 'refunds.$.status': 'completed', 'refunds.$.walletTransactionId': transactionId } },
    );
    await UsageChargeModel.updateOne({ _id: chargeId }, [
      {
        $set: {
          status: { $cond: [{ $gte: ['$refundedMinor', '$amountMinor'] }, 'refunded', 'partially_refunded'] },
        },
      },
    ]);
    return true;
  }
}

export const usageChargeService = new UsageChargeService();
