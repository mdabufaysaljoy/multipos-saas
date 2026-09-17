import { Types, type HydratedDocument } from 'mongoose';
import { AccountModel } from '../../models/Account';
import { TenantModel } from '../../models/Tenant';
import { WalletModel, type WalletDoc } from '../../models/Wallet';
import { WalletTransactionModel, type WalletSource, type WalletTransactionDoc, type WalletTxType } from '../../models/WalletTransaction';
import { PaymentModel } from '../../models/Payment';
import { UserModel } from '../../models/User';
import { PAYMENT_STATUS, ROLES } from '../../config/constants';
import { sessionOpt, withTransaction } from '../../utils/tx';
import { logger } from '../../utils/logger';
import type { ClientSession } from 'mongoose';
import { ApiError } from '../../utils/ApiError';
import { resolvePage } from '../../utils/pagination';

export interface MovementInput {
  amountMinor: number;
  reason: string;
  referenceType?: 'topup' | 'subscription' | 'sms' | 'email' | 'ai' | 'storage' | 'refund' | 'adjustment' | null;
  referenceId?: Types.ObjectId | null;
  performedBy?: Types.ObjectId | null;
  performedByName?: string;
  metadata?: Record<string, unknown>;
  /** Where the money came from or went. Derived from `referenceType` when omitted. */
  source?: WalletSource;
  /** The same key moves money once; a repeat returns the original movement. */
  idempotencyKey?: string | null;
  /** On a compensating movement: the transaction it corrects. */
  reversalOfTransactionId?: Types.ObjectId | null;
}

type LedgerRow = WalletTransactionDoc & { _id: Types.ObjectId };

export interface MovementResult {
  transaction: LedgerRow;
  balanceMinor: number;
  /** True when an earlier request with the same idempotency key already moved the money. */
  replayed: boolean;
}

/** How many recent operation keys a wallet keeps for the atomic duplicate check. Older keys are found in the ledger. */
const OPERATION_KEY_WINDOW = 1000;
const OPERATION_KEY_PATTERN = /^[A-Za-z0-9:_.-]{8,200}$/;

/** The direction of a ledger row. Adjustments carry theirs in the balances. */
export const ledgerDirection = (row: Pick<WalletTransactionDoc, 'type' | 'balanceBeforeMinor' | 'balanceAfterMinor'>): 'in' | 'out' =>
  row.type === 'credit' || row.type === 'refund' || row.type === 'transfer_in' || (row.type === 'adjustment' && row.balanceAfterMinor >= row.balanceBeforeMinor)
    ? 'in'
    : 'out';

const sourceFor = (input: MovementInput): WalletSource => {
  if (input.source) return input.source;
  const method = typeof input.metadata?.method === 'string' ? input.metadata.method : '';
  switch (input.referenceType) {
    case 'topup':
      return method === 'bkash' || method === 'nagad' || method === 'bank' ? method : 'manual_topup';
    case 'subscription':
    case 'sms':
    case 'email':
    case 'ai':
    case 'storage':
      return input.referenceType;
    case 'adjustment':
      return 'admin_adjustment';
    case 'refund':
      return 'refund';
    default:
      return 'system';
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Who is reading a ledger. The account owner sees every workspace's rows; any
 * other user sees only the rows their own workspace generated. The balance
 * itself is shared, because every workspace of the account spends from it.
 */
export interface LedgerViewer {
  userId: Types.ObjectId;
}

const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;

type WalletHandle = Pick<WalletDoc, '_id' | 'accountId' | 'balanceMinor' | 'currency' | 'isFrozen'>;
type WalletRecord = HydratedDocument<WalletDoc>;

/**
 * All wallet movement flows through here.
 *
 * ONE WALLET PER ACCOUNT. Callers still pass the workspace (`tenantId`) doing
 * the spending; the wallet is resolved on the server from that workspace's
 * stored account, so no request can choose which wallet it touches. Ledger rows
 * keep the workspace that caused them, so per-workspace spend stays traceable.
 * A workspace not yet linked to an account keeps its own legacy wallet exactly
 * as before.
 *
 * Guarantees:
 *  1. The balance is never edited without a matching ledger row. The row is
 *     written from the pre-image of the same atomic update.
 *  2. A debit uses a conditional update (`balanceMinor: { $gte: amount }`), so
 *     concurrent debits cannot overdraw the wallet.
 *  3. Merging a legacy wallet into the account wallet moves money only through
 *     ledgered transfer_out / transfer_in rows, credits exactly once, and can be
 *     resumed if it is interrupted part-way.
 */
class WalletService {
  /** The wallet that pays for this workspace, opened on first access. */
  async getOrCreate(tenantId: Types.ObjectId): Promise<WalletRecord> {
    const tenant = await TenantModel.findById(tenantId).select('_id accountId').lean();
    if (!tenant) throw ApiError.notFound('Workspace not found');
    return tenant.accountId ? this.accountWallet(tenant.accountId, tenantId) : this.legacyWallet(tenantId);
  }

  async balance(tenantId: Types.ObjectId) {
    const wallet = await this.getOrCreate(tenantId);
    // Lifetime totals include wallets merged into this one, so the account's
    // history adds up. Transfers never count towards either total.
    const family = await WalletModel.find({ $or: [{ _id: wallet._id }, { mergedIntoWalletId: wallet._id }] })
      .select('lifetimeCreditedMinor lifetimeDebitedMinor')
      .lean();
    return {
      balanceMinor: wallet.balanceMinor,
      currency: wallet.currency,
      lifetimeCreditedMinor: family.reduce((sum, w) => sum + (w.lifetimeCreditedMinor ?? 0), 0),
      lifetimeDebitedMinor: family.reduce((sum, w) => sum + (w.lifetimeDebitedMinor ?? 0), 0),
      isFrozen: wallet.isFrozen,
      status: wallet.isFrozen ? ('frozen' as const) : ('active' as const),
      accountId: wallet.accountId ?? null,
    };
  }

  /** Adds money. Used by approved top-ups, confirmed payments, refunds and admin adjustments. */
  async credit(tenantId: Types.ObjectId, input: MovementInput, type: WalletTxType = 'credit'): Promise<MovementResult> {
    return this.move(tenantId, 'in', type, input);
  }

  /**
   * Removes money, refusing to overdraw. The `$gte` precondition means two
   * simultaneous debits for the last of the balance cannot both succeed.
   */
  async debit(tenantId: Types.ObjectId, input: MovementInput): Promise<MovementResult> {
    return this.move(tenantId, 'out', 'debit', input);
  }

  /**
   * THE way money moves. One conditional update on the wallet document both
   * checks and applies the movement - enough balance for a debit, the wallet not
   * merged away, and the idempotency key not applied yet - so double debits,
   * overdrafts and duplicate credits are impossible even without transactions.
   * Where the deployment supports MongoDB transactions, the balance change and
   * its ledger row also commit together.
   */
  private async move(tenantId: Types.ObjectId, direction: 'in' | 'out', type: WalletTxType, input: MovementInput): Promise<MovementResult> {
    this.assertAmount(input.amountMinor);
    const key = input.idempotencyKey ?? null;
    if (key !== null && !OPERATION_KEY_PATTERN.test(key)) throw ApiError.badRequest('Invalid operation key');

    // Two attempts: if the wallet was merged away between resolving it and
    // writing to it, resolving again lands on the account wallet.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const wallet = await this.getOrCreate(tenantId);
      if (key) {
        const replay = await this.replay(wallet._id, key, type, input.amountMinor);
        if (replay) return replay;
      }
      if (direction === 'out' && wallet.isFrozen) throw ApiError.forbidden('This wallet is frozen. Contact support.');

      const moved = await withTransaction(async (session) => {
        const filter: Record<string, unknown> = { _id: wallet._id, mergedIntoWalletId: null };
        if (direction === 'out') {
          filter.isFrozen = false;
          filter.balanceMinor = { $gte: input.amountMinor };
        }
        if (key) filter.appliedOperationKeys = { $ne: key };
        const update: Record<string, unknown> = {
          // The sequence is taken from the same atomic update as the balance, so
          // two movements in the same millisecond can never be listed out of order.
          $inc:
            direction === 'in'
              ? // Any inbound movement that is NOT a refund is money added.
                { balanceMinor: input.amountMinor, ledgerSequence: 1, ...(type === 'refund' ? {} : { lifetimeCreditedMinor: input.amountMinor }) }
              : { balanceMinor: -input.amountMinor, ledgerSequence: 1, lifetimeDebitedMinor: input.amountMinor },
        };
        if (key) update.$push = { appliedOperationKeys: { $each: [key], $slice: -OPERATION_KEY_WINDOW } };

        const before = await WalletModel.findOneAndUpdate(filter, update, { new: false, ...sessionOpt(session) }).lean();
        if (!before) return null;
        const after = direction === 'in' ? before.balanceMinor + input.amountMinor : before.balanceMinor - input.amountMinor;
        return this.writeLedger(tenantId, { _id: wallet._id, accountId: before.accountId, currency: before.currency }, type, input, before.balanceMinor, after, (before.ledgerSequence ?? 0) + 1, session);
      });
      if (moved) return moved;

      // Nothing matched: work out why.
      if (key && (await WalletModel.exists({ _id: wallet._id, appliedOperationKeys: key }))) {
        // The same operation is being (or was just) applied by another request.
        for (let wait = 0; wait < 30; wait += 1) {
          const replay = await this.replay(wallet._id, key, type, input.amountMinor);
          if (replay) return replay;
          await sleep(100);
        }
        logger.error('A wallet operation key is applied but has no ledger row', { walletId: String(wallet._id), key });
        throw ApiError.conflict('This wallet operation is still being processed. Try again shortly.', { reason: 'OPERATION_IN_PROGRESS' });
      }
      const current = await WalletModel.findById(wallet._id).select('balanceMinor isFrozen mergedIntoWalletId').lean();
      if (current?.mergedIntoWalletId) continue;
      if (direction === 'out') {
        if (current?.isFrozen) throw ApiError.forbidden('This wallet is frozen. Contact support.');
        throw ApiError.badRequest(
          `Insufficient wallet balance. Available ${((current?.balanceMinor ?? 0) / 100).toFixed(2)}, required ${(input.amountMinor / 100).toFixed(2)}.`,
          { availableMinor: current?.balanceMinor ?? 0, requiredMinor: input.amountMinor },
        );
      }
    }
    throw ApiError.conflict('The wallet changed while this payment was processed. Please try again.');
  }

  /** The earlier movement made with this key, if any. The same key for a different movement is refused. */
  private async replay(walletId: Types.ObjectId, key: string, type: WalletTxType, amountMinor: number): Promise<MovementResult | null> {
    const row = await WalletTransactionModel.findOne({ walletId: { $in: await this.familyIds(walletId) }, idempotencyKey: key }).lean<LedgerRow>();
    if (!row) return null;
    if (row.type !== type || row.amountMinor !== amountMinor) {
      throw ApiError.conflict('That operation key was already used for a different wallet movement', { reason: 'IDEMPOTENCY_KEY_REUSED' });
    }
    return { transaction: row, balanceMinor: row.balanceAfterMinor, replayed: true };
  }

  /** A wallet and every legacy wallet merged into it: the rows an account's ledger spans. */
  async familyIds(walletId: Types.ObjectId): Promise<Types.ObjectId[]> {
    const merged = await WalletModel.find({ mergedIntoWalletId: walletId }).select('_id').lean();
    return [walletId, ...merged.map((wallet) => wallet._id)];
  }

  /**
   * Corrects a posted transaction with a compensating one: the opposite
   * movement, linked to the original. The original is never edited. A row is
   * reversed at most once, and a reversal cannot itself be reversed.
   */
  async reverse(
    transactionId: Types.ObjectId,
    input: { reason: string; performedBy: Types.ObjectId | null; performedByName: string },
    walletIds?: Types.ObjectId[],
  ): Promise<MovementResult> {
    const original = await WalletTransactionModel.findOne({ _id: transactionId, ...(walletIds ? { walletId: { $in: walletIds } } : {}) }).lean<LedgerRow>();
    if (!original) throw ApiError.notFound('Transaction not found');
    if (original.type === 'transfer_in' || original.type === 'transfer_out') {
      throw ApiError.badRequest("A move between the account's own wallets cannot be reversed");
    }
    if (original.reversalOfTransactionId) throw ApiError.badRequest('A reversal cannot itself be reversed. Record a new adjustment instead.');
    if (await WalletTransactionModel.exists({ reversalOfTransactionId: original._id })) {
      throw ApiError.conflict('This transaction has already been reversed', { reason: 'ALREADY_REVERSED' });
    }

    const movement: MovementInput = {
      amountMinor: original.amountMinor,
      reason: `Reversal of ${String(original._id)}: ${input.reason}`.slice(0, 300),
      referenceType: 'adjustment',
      referenceId: original._id,
      performedBy: input.performedBy,
      performedByName: input.performedByName,
      source: 'reversal',
      idempotencyKey: `reversal:${String(original._id)}`,
      reversalOfTransactionId: original._id,
    };
    try {
      return ledgerDirection(original) === 'in' ? await this.debit(original.tenantId, movement) : await this.credit(original.tenantId, movement, 'adjustment');
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw ApiError.conflict('This transaction has already been reversed', { reason: 'ALREADY_REVERSED' });
      throw error;
    }
  }

  /**
   * Credits the wallet from a CONFIRMED payment - the only way a gateway or
   * transfer payment adds money. A payment that is not paid adds nothing, and
   * the same payment credits once however many confirmations arrive.
   */
  async creditFromPayment(paymentId: Types.ObjectId): Promise<MovementResult> {
    const payment = await PaymentModel.findById(paymentId).lean();
    if (!payment) throw ApiError.notFound('Payment not found');
    if (payment.status !== PAYMENT_STATUS.PAID) throw ApiError.conflict('Only a confirmed payment can add money to the wallet', { reason: 'PAYMENT_NOT_CONFIRMED' });
    if ((payment.metadata as { purpose?: string } | undefined)?.purpose !== 'wallet_topup') {
      throw ApiError.badRequest('This payment is not a wallet top-up');
    }
    const source: WalletSource = payment.provider === 'bkash' || payment.provider === 'nagad' || payment.provider === 'bank' ? payment.provider : 'manual_topup';
    return this.credit(payment.tenantId, {
      amountMinor: payment.amountMinor,
      reason: `Wallet top-up via ${payment.provider}`,
      referenceType: 'topup',
      referenceId: payment._id,
      performedBy: null,
      performedByName: payment.provider,
      source,
      idempotencyKey: `payment:${String(payment._id)}`,
    });
  }

  /** True when the wallet can cover an amount - checked before starting work. */
  async canAfford(tenantId: Types.ObjectId, amountMinor: number) {
    const wallet = await this.getOrCreate(tenantId);
    return !wallet.isFrozen && wallet.balanceMinor >= amountMinor;
  }

  async transactions(
    tenantId: Types.ObjectId,
    input: {
      page?: number;
      limit?: number;
      type?: string;
      service?: string;
      direction?: 'credit' | 'debit';
      from?: Date;
      to?: Date;
      sortBy?: string;
      /** Only this workspace's movements. The caller has already checked it belongs to the account. */
      workspaceId?: Types.ObjectId;
    },
    viewer?: LedgerViewer,
  ) {
    const { page, limit, skip } = resolvePage(input);
    const { filter } = await this.ledgerScope(tenantId, viewer);

    if (input.type) filter.type = input.type;
    if (input.workspaceId) filter.tenantId = input.workspaceId;
    if (input.service) filter.referenceType = input.service;
    // "credit" covers refunds too - both increase the balance.
    if (input.direction === 'credit') filter.type = { $in: ['credit', 'refund'] };
    if (input.direction === 'debit') filter.type = 'debit';
    if (input.from || input.to) {
      filter.createdAt = { ...(input.from ? { $gte: input.from } : {}), ...(input.to ? { $lte: input.to } : {}) };
    }

    const SORTS: Record<string, Record<string, 1 | -1>> = {
      // `_id` breaks ties, so paging never skips or repeats a row written in the same millisecond.
      // `sequence` is the chain order; `_id` still breaks ties for rows written before it existed.
      newest: { createdAt: -1, sequence: -1, _id: -1 },
      oldest: { createdAt: 1, sequence: 1, _id: 1 },
      highest: { amountMinor: -1, _id: -1 },
      lowest: { amountMinor: 1, _id: 1 },
    };
    const sort = SORTS[input.sortBy ?? 'newest'] ?? SORTS.newest;

    const [items, total] = await Promise.all([
      WalletTransactionModel.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      WalletTransactionModel.countDocuments(filter),
    ]);

    return { items, page, limit, total };
  }

  /**
   * Spending grouped by the service that consumed it.
   *
   * Derived from the ledger's `referenceType`, so the figures always reconcile
   * with the transaction list. Transfers between the account's own wallets are
   * neither money added nor money spent, so they are excluded by type.
   */
  async breakdown(tenantId: Types.ObjectId, range?: { from?: Date; to?: Date }, viewer?: LedgerViewer) {
    const { wallet, filter: match } = await this.ledgerScope(tenantId, viewer);
    if (range?.from || range?.to) {
      match.createdAt = { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lte: range.to } : {}) };
    }

    const rows = await WalletTransactionModel.aggregate<{
      _id: { referenceType: string | null; type: string };
      amountMinor: number;
      count: number;
    }>([
      { $match: match },
      { $group: { _id: { referenceType: '$referenceType', type: '$type' }, amountMinor: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
    ]);

    const spendOn = (service: string) =>
      rows
        .filter((r) => r._id.referenceType === service && r._id.type === 'debit')
        .reduce((sum, r) => sum + r.amountMinor, 0) -
      rows
        .filter((r) => r._id.referenceType === service && r._id.type === 'refund')
        .reduce((sum, r) => sum + r.amountMinor, 0);

    // Money the customer ADDED, kept separate from money returned to them.
    const totalCredits = rows
      .filter((r) => r._id.type === 'credit' || r._id.type === 'adjustment')
      .reduce((sum, r) => sum + r.amountMinor, 0);
    const totalRefunds = rows.filter((r) => r._id.type === 'refund').reduce((sum, r) => sum + r.amountMinor, 0);
    const totalDebits = rows.filter((r) => r._id.type === 'debit').reduce((sum, r) => sum + r.amountMinor, 0);

    const subscription = spendOn('subscription');
    const sms = spendOn('sms');
    const email = spendOn('email');

    // The named services are already net of their refunds, so "other" must be
    // derived from NET debits too.
    const netDebits = totalDebits - totalRefunds;
    const other = Math.max(0, netDebits - subscription - sms - email);

    return {
      balanceMinor: wallet.balanceMinor,
      currency: wallet.currency,
      totalCreditsMinor: totalCredits,
      totalRefundsMinor: totalRefunds,
      totalDebitsMinor: netDebits,
      grossDebitsMinor: totalDebits,
      services: [
        { service: 'subscription', label: 'Subscription', amountMinor: subscription },
        { service: 'sms', label: 'SMS', amountMinor: sms },
        { service: 'email', label: 'Email', amountMinor: email },
        { service: 'other', label: 'Other platform services', amountMinor: other },
      ],
    };
  }

  // ------------------------------------------------------------ merging

  /**
   * Moves a legacy workspace wallet into an account wallet.
   *
   * Step 1 is ONE atomic write that empties and freezes the old wallet and
   * records exactly how much was taken (`pendingTransferMinor`). From that
   * moment the money is always visible - in the pending field until the
   * account wallet is credited - so an interruption can never lose it.
   */
  async mergeWallet(absorbedId: Types.ObjectId, primaryId: Types.ObjectId): Promise<number> {
    if (absorbedId.equals(primaryId)) throw ApiError.badRequest('A wallet cannot be merged into itself');

    const [absorbed, primary] = await Promise.all([
      WalletModel.findById(absorbedId).select('accountId currency mergedIntoWalletId').lean(),
      WalletModel.findById(primaryId).select('accountId currency mergedIntoWalletId').lean(),
    ]);
    if (!absorbed || !primary) throw ApiError.notFound('Wallet not found');
    if (!primary.accountId || primary.mergedIntoWalletId) {
      throw ApiError.conflict('Only an account wallet can receive a merged balance');
    }
    if (absorbed.accountId) throw ApiError.conflict('An account wallet cannot be merged into another wallet');
    if (absorbed.mergedIntoWalletId && !absorbed.mergedIntoWalletId.equals(primaryId)) {
      throw ApiError.conflict('This wallet has already been merged into a different wallet');
    }
    if (absorbed.currency !== primary.currency) {
      throw ApiError.conflict(
        `A ${absorbed.currency} wallet cannot be merged into a ${primary.currency} wallet. Contact support to settle it.`,
      );
    }

    await WalletModel.updateOne({ _id: absorbedId, accountId: null, mergedIntoWalletId: null }, [
      {
        $set: {
          pendingTransferMinor: '$balanceMinor',
          pendingTransferId: { $literal: new Types.ObjectId() },
          balanceMinor: 0,
          isFrozen: true,
          status: 'frozen',
          mergedIntoWalletId: { $literal: primaryId },
          mergedAt: '$$NOW',
        },
      },
    ]);

    return this.completeTransfer(absorbedId);
  }

  /**
   * Finishes a merge whose balance has been taken but not yet delivered.
   * Safe to call any number of times, including concurrently.
   */
  async completeTransfer(absorbedId: Types.ObjectId): Promise<number> {
    const absorbed = await WalletModel.findById(absorbedId).lean();
    if (!absorbed?.mergedIntoWalletId || !absorbed.pendingTransferId || !((absorbed.pendingTransferMinor ?? 0) > 0)) {
      return 0;
    }

    const amount = absorbed.pendingTransferMinor;
    const transferId = absorbed.pendingTransferId;
    const primaryId = absorbed.mergedIntoWalletId;
    const primary = await WalletModel.findById(primaryId).select('accountId tenantId currency').lean();
    if (!primary) throw ApiError.notFound('Account wallet not found');

    // Money out of the old wallet (exactly once, by unique index).
    const absorbedSeq = await this.nextSequence(absorbedId);
    await this.insertLedgerOnce({
      tenantId: absorbed.tenantId,
      accountId: primary.accountId,
      walletId: absorbedId,
      type: 'transfer_out',
      amountMinor: amount,
      currency: absorbed.currency,
      balanceBeforeMinor: amount,
      balanceAfterMinor: 0,
      sequence: absorbedSeq,
      reason: 'Balance moved into the account wallet',
      referenceType: 'transfer',
      referenceId: transferId,
      metadata: { toWalletId: primaryId },
    });

    // Money into the account wallet. The `$ne` guard makes the credit itself
    // exactly-once: a second caller finishing the same merge matches nothing.
    const before = await WalletModel.findOneAndUpdate(
      { _id: primaryId, appliedTransferIds: { $ne: transferId } },
      { $inc: { balanceMinor: amount, ledgerSequence: 1 }, $push: { appliedTransferIds: transferId } },
      { new: false },
    ).lean();

    const transferIn = {
      tenantId: primary.tenantId,
      accountId: primary.accountId,
      walletId: primaryId,
      type: 'transfer_in' as const,
      amountMinor: amount,
      currency: primary.currency,
      reason: 'Balance moved in from a workspace wallet',
      referenceType: 'transfer' as const,
      referenceId: transferId,
    };

    if (before) {
      await this.insertLedgerOnce({
        ...transferIn,
        balanceBeforeMinor: before.balanceMinor,
        balanceAfterMinor: before.balanceMinor + amount,
        sequence: (before.ledgerSequence ?? 0) + 1,
        metadata: { fromWalletId: absorbedId },
      });
    } else if (!(await WalletTransactionModel.exists({ walletId: primaryId, type: 'transfer_in', referenceId: transferId }))) {
      // The credit landed but the process stopped before its ledger row. The
      // exact pre-image is gone, so the row is written from the current balance
      // and flagged as reconstructed rather than silently omitted.
      const current = await WalletModel.findById(primaryId).select('balanceMinor').lean();
      const after = current?.balanceMinor ?? amount;
      await this.insertLedgerOnce({
        ...transferIn,
        balanceBeforeMinor: after - amount,
        balanceAfterMinor: after,
        sequence: await this.nextSequence(primaryId),
        metadata: { fromWalletId: absorbedId, reconstructed: true },
      });
    }

    await WalletModel.updateOne({ _id: absorbedId, pendingTransferId: transferId }, { $set: { pendingTransferMinor: 0 } });
    return amount;
  }

  // ------------------------------------------------------------ internals

  private async legacyWallet(tenantId: Types.ObjectId): Promise<WalletRecord> {
    const existing = await WalletModel.findOne({ tenantId });
    if (existing) return existing;
    // upsert avoids a duplicate-key race when two requests arrive together.
    await WalletModel.updateOne({ tenantId }, { $setOnInsert: { tenantId, balanceMinor: 0 } }, { upsert: true });
    return (await WalletModel.findOne({ tenantId }))!;
  }

  private async accountWallet(accountId: Types.ObjectId, tenantId: Types.ObjectId): Promise<WalletRecord> {
    let wallet: WalletRecord | null = await WalletModel.findOne({ accountId });

    if (!wallet) {
      // First use under the account: adopt this workspace's own wallet, so its
      // balance and history carry over untouched.
      try {
        wallet = await WalletModel.findOneAndUpdate(
          { tenantId, accountId: null, mergedIntoWalletId: null },
          { $set: { accountId } },
          { new: true },
        );
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }

    if (!wallet) {
      try {
        await WalletModel.updateOne({ accountId }, { $setOnInsert: { tenantId, balanceMinor: 0 } }, { upsert: true });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
      wallet = await WalletModel.findOne({ accountId });
      if (!wallet) throw ApiError.internal('The wallet could not be opened');
    }

    return this.settleStragglers(wallet, tenantId);
  }

  /**
   * Money that belongs in the account wallet but is not there yet: this
   * workspace's own unlinked wallet, or a merge interrupted before it finished.
   */
  private async settleStragglers(wallet: WalletRecord, tenantId: Types.ObjectId): Promise<WalletRecord> {
    const stragglers = await WalletModel.find({
      _id: { $ne: wallet._id },
      $or: [
        { tenantId, accountId: null, mergedIntoWalletId: null },
        { mergedIntoWalletId: wallet._id, pendingTransferMinor: { $gt: 0 } },
      ],
    })
      .select('_id mergedIntoWalletId')
      .lean();

    if (stragglers.length === 0) return wallet;

    for (const straggler of stragglers) {
      if (straggler.mergedIntoWalletId) await this.completeTransfer(straggler._id);
      else await this.mergeWallet(straggler._id, wallet._id);
    }
    return (await WalletModel.findById(wallet._id))!;
  }

  /** The wallet plus any wallets merged into it: the rows an account's ledger spans. */
  private async ledgerScope(tenantId: Types.ObjectId, viewer?: LedgerViewer) {
    const wallet = await this.getOrCreate(tenantId);
    const merged = await WalletModel.find({ mergedIntoWalletId: wallet._id }).select('_id').lean();
    const filter: Record<string, unknown> = { walletId: { $in: [wallet._id, ...merged.map((w) => w._id)] } };

    if (viewer && wallet.accountId) {
      const account = await AccountModel.findById(wallet.accountId).select('ownerUserId').lean();
      if (!account || !account.ownerUserId.equals(viewer.userId)) filter.tenantId = tenantId;
    }
    return { wallet, filter };
  }

  private assertAmount(amountMinor: number) {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw ApiError.badRequest('Wallet amount must be a positive whole number of minor units');
    }
  }

  /** The next position in a wallet's ledger, claimed atomically. */
  private async nextSequence(walletId: Types.ObjectId): Promise<number> {
    const updated = await WalletModel.findOneAndUpdate({ _id: walletId }, { $inc: { ledgerSequence: 1 } }, { new: true }).select('ledgerSequence').lean();
    return updated?.ledgerSequence ?? 1;
  }

  private async insertLedgerOnce(row: Record<string, unknown>) {
    try {
      await WalletTransactionModel.create([{ performedBy: null, performedByNameSnapshot: 'system', source: 'transfer', status: 'posted', ...row }]);
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  private async writeLedger(
    tenantId: Types.ObjectId,
    wallet: Pick<WalletHandle, '_id' | 'accountId' | 'currency'>,
    type: WalletTxType,
    input: MovementInput,
    balanceBeforeMinor: number,
    balanceAfterMinor: number,
    sequence: number,
    session?: ClientSession,
  ): Promise<MovementResult> {
    const [row] = await WalletTransactionModel.create(
      [
        {
          // The workspace that caused the movement, and the account that paid.
          tenantId,
          accountId: wallet.accountId ?? null,
          walletId: wallet._id,
          type,
          amountMinor: input.amountMinor,
          balanceBeforeMinor,
          balanceAfterMinor,
          sequence,
          currency: wallet.currency,
          source: sourceFor(input),
          status: 'posted',
          reason: input.reason,
          referenceType: input.referenceType ?? null,
          referenceId: input.referenceId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          reversalOfTransactionId: input.reversalOfTransactionId ?? null,
          performedBy: input.performedBy ?? null,
          performedByNameSnapshot: input.performedByName ?? 'system',
          metadata: input.metadata ?? {},
        },
      ],
      sessionOpt(session),
    );

    return { transaction: row.toObject() as LedgerRow, balanceMinor: balanceAfterMinor, replayed: false };
  }
}

export const walletService = new WalletService();

/**
 * Ledger rows as a CUSTOMER sees them: no provider metadata, no operation keys,
 * and actions by platform staff shown as "Platform support" rather than a name.
 */
export async function presentLedgerRows(rows: LedgerRow[]) {
  const performerIds = [...new Set(rows.map((row) => row.performedBy).filter(Boolean).map(String))].map((id) => new Types.ObjectId(id));
  const platform = performerIds.length
    ? new Set((await UserModel.find({ _id: { $in: performerIds }, role: ROLES.PLATFORM_ADMIN }).select('_id').lean()).map((user) => String(user._id)))
    : new Set<string>();
  return rows.map((row) => ({
    _id: row._id,
    id: row._id,
    // The customer's own account, and the workspace whose action caused the movement.
    accountId: row.accountId ?? null,
    tenantId: row.tenantId,
    workspaceId: row.tenantId,
    type: row.type,
    direction: ledgerDirection(row),
    amountMinor: row.amountMinor,
    currency: row.currency ?? 'BDT',
    balanceBeforeMinor: row.balanceBeforeMinor,
    balanceAfterMinor: row.balanceAfterMinor,
    reason: row.reason,
    description: row.reason,
    source: row.source ?? 'system',
    status: row.status ?? 'posted',
    referenceType: row.referenceType,
    reversalOfTransactionId: row.reversalOfTransactionId ?? null,
    performedByNameSnapshot: row.performedBy && platform.has(String(row.performedBy)) ? 'Platform support' : row.performedByNameSnapshot,
    createdAt: row.createdAt,
  }));
}
