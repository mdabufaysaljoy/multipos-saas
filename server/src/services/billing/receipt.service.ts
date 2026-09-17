import { Types } from 'mongoose';
import { env } from '../../config/env';
import { AccountModel } from '../../models/Account';
import { nextDocumentSequence } from '../../models/DocumentSequence';
import { getPlatformSettings } from '../../models/PlatformSettings';
import { TenantModel } from '../../models/Tenant';
import { TopUpRequestModel, type TopUpRequestDoc } from '../../models/TopUpRequest';
import { UserModel } from '../../models/User';
import { WalletReceiptModel, type WalletReceiptDoc } from '../../models/WalletReceipt';
import { WalletTransactionModel } from '../../models/WalletTransaction';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { resolvePage } from '../../utils/pagination';

type ReceiptRecord = WalletReceiptDoc & { _id: Types.ObjectId };
type TopUpRecord = TopUpRequestDoc & { _id: Types.ObjectId };

const DAY_MS = 86_400_000;
/** An approval older than this with no ledger link was interrupted mid-way. */
const STUCK_APPROVAL_MS = 5 * 60_000;
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;

export const formatReceiptNumber = (year: number, sequence: number) => `RCPT-${year}-${String(sequence).padStart(6, '0')}`;
const lastFour = (value: string | null | undefined) => (value ?? '').replace(/\D/g, '').slice(-4);

async function linkTopUp(topUpId: Types.ObjectId, receiptId: Types.ObjectId) {
  await TopUpRequestModel.updateOne({ _id: topUpId, receiptId: null }, { $set: { receiptId } }, { timestamps: false });
}

/**
 * Issues the receipt for an approved top-up, exactly once. Snapshot of the
 * approval: amount, method, the customer's transaction reference, the last four
 * digits of the sending number, who paid, and the balance right after the credit.
 */
export async function issueReceiptForTopUp(topUpId: Types.ObjectId): Promise<ReceiptRecord | null> {
  const existing = await WalletReceiptModel.findOne({ topUpRequestId: topUpId }).lean<ReceiptRecord>();
  if (existing) {
    await linkTopUp(topUpId, existing._id);
    return existing;
  }

  const topUp = await TopUpRequestModel.findById(topUpId).lean<TopUpRecord>();
  if (!topUp || topUp.status !== 'approved' || !topUp.walletTransactionId) return null;

  const [ledger, workspace, settings] = await Promise.all([
    WalletTransactionModel.findOne({ _id: topUp.walletTransactionId, tenantId: topUp.tenantId }).select('balanceAfterMinor createdAt').lean(),
    TenantModel.findById(topUp.tenantId).select('name accountId ownerUserId contactEmail contactPhone').lean(),
    getPlatformSettings(),
  ]);
  if (!ledger) return null;
  const [account, owner] = await Promise.all([
    workspace?.accountId ? AccountModel.findById(workspace.accountId).select('name contactEmail contactPhone').lean() : null,
    workspace ? UserModel.findById(workspace.ownerUserId).select('name email').lean() : null,
  ]);

  const issuedAt = topUp.reviewedAt ?? ledger.createdAt ?? new Date();
  const year = issuedAt.getUTCFullYear();
  const raced = await WalletReceiptModel.findOne({ topUpRequestId: topUpId }).lean<ReceiptRecord>();
  if (raced) {
    await linkTopUp(topUpId, raced._id);
    return raced;
  }
  const sequence = await nextDocumentSequence(`receipt:${year}`);

  try {
    const receipt = await WalletReceiptModel.create({
      number: formatReceiptNumber(year, sequence),
      year,
      sequence,
      accountId: workspace?.accountId ?? null,
      tenantId: topUp.tenantId,
      topUpRequestId: topUp._id,
      walletTransactionId: topUp.walletTransactionId,
      issuedAt,
      amountMinor: topUp.amountMinor,
      currency: topUp.currency,
      issuer: { name: env.INVOICE_ISSUER_NAME, address: env.INVOICE_ISSUER_ADDRESS, email: settings.supportEmail ?? '', phone: settings.supportPhone ?? '' },
      receivedFrom: {
        accountName: account?.name || owner?.name || workspace?.name || '',
        workspaceName: workspace?.name ?? '',
        email: account?.contactEmail || workspace?.contactEmail || owner?.email || '',
        phone: account?.contactPhone || workspace?.contactPhone || '',
      },
      payment: { method: topUp.paymentMethod, transactionId: topUp.transactionId, senderLast4: lastFour(topUp.senderNumber) },
      balanceAfterMinor: typeof ledger.balanceAfterMinor === 'number' ? ledger.balanceAfterMinor : null,
    });
    await linkTopUp(topUp._id, receipt._id);
    return receipt.toObject() as ReceiptRecord;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const winner = await WalletReceiptModel.findOne({ topUpRequestId: topUpId }).lean<ReceiptRecord>();
    if (!winner) throw error;
    logger.warn('Two processes issued a receipt for the same top-up; a receipt number was skipped', { topUpId: String(topUpId), skipped: formatReceiptNumber(year, sequence) });
    await linkTopUp(topUpId, winner._id);
    return winner;
  }
}

/** For the approval path: a receipt problem must never undo a credited top-up. */
export async function issueReceiptSafely(topUpId: Types.ObjectId) {
  try {
    return await issueReceiptForTopUp(topUpId);
  } catch (error) {
    logger.error('Issuing a top-up receipt failed; the receipt sweep will retry', { topUpId: String(topUpId), error: error instanceof Error ? error.message : 'unknown' });
    return null;
  }
}

/**
 * Finishes top-up approvals that were interrupted, then issues missing receipts.
 *
 *   - approved, no ledger link, but a ledger credit exists  -> link it (money did move)
 *   - approved, no ledger link, no ledger credit            -> back to pending (no money moved)
 */
export async function issueMissingReceipts(limit = 200, now = new Date()) {
  const stuck = await TopUpRequestModel.find({ status: 'approved', walletTransactionId: null, reviewedAt: { $lt: new Date(now.getTime() - STUCK_APPROVAL_MS) } })
    .limit(100)
    .select('_id tenantId')
    .lean();
  let relinked = 0;
  let reverted = 0;
  for (const topUp of stuck) {
    const credit = await WalletTransactionModel.findOne({ tenantId: topUp.tenantId, referenceType: 'topup', referenceId: topUp._id }).select('_id').lean();
    if (credit) {
      const linked = await TopUpRequestModel.updateOne({ _id: topUp._id, walletTransactionId: null }, { $set: { walletTransactionId: credit._id } });
      relinked += linked.modifiedCount;
    } else {
      const back = await TopUpRequestModel.updateOne(
        { _id: topUp._id, status: 'approved', walletTransactionId: null },
        { $set: { status: 'pending', reviewedBy: null, reviewedByNameSnapshot: '', reviewedAt: null, reviewNote: '' } },
      );
      reverted += back.modifiedCount;
    }
  }
  if (relinked + reverted > 0) logger.warn('Repaired interrupted top-up approvals', { relinked, reverted });

  const missing = await TopUpRequestModel.find({ status: 'approved', walletTransactionId: { $ne: null }, receiptId: null }).sort({ _id: 1 }).limit(limit).select('_id').lean();
  let issued = 0;
  for (const topUp of missing) {
    if (await issueReceiptSafely(topUp._id)) issued += 1;
  }
  if (issued > 0) logger.info('Issued missing top-up receipts', { issued });
  return { checked: missing.length, issued, relinked, reverted };
}

// ------------------------------------------------------------------ reading

export function presentReceipt(receipt: ReceiptRecord) {
  return {
    id: receipt._id,
    number: receipt.number,
    issuedAt: receipt.issuedAt,
    topUpId: receipt.topUpRequestId,
    workspace: { id: receipt.tenantId, name: receipt.receivedFrom.workspaceName },
    amountMinor: receipt.amountMinor,
    currency: receipt.currency,
    issuer: receipt.issuer,
    receivedFrom: receipt.receivedFrom,
    payment: receipt.payment,
    balanceAfterMinor: receipt.balanceAfterMinor,
  };
}

export async function listReceipts(tenantIds: Types.ObjectId[], input: { page?: number; limit?: number; from?: Date; to?: Date }) {
  const { page, limit, skip } = resolvePage(input);
  const filter: Record<string, unknown> = { tenantId: { $in: tenantIds } };
  if (input.from || input.to) {
    filter.issuedAt = { ...(input.from ? { $gte: input.from } : {}), ...(input.to ? { $lt: new Date(input.to.getTime() + DAY_MS) } : {}) };
  }
  const [receipts, total] = await Promise.all([
    WalletReceiptModel.find(filter).sort({ issuedAt: -1, _id: -1 }).skip(skip).limit(limit).lean<ReceiptRecord[]>(),
    WalletReceiptModel.countDocuments(filter),
  ]);
  return { items: receipts.map(presentReceipt), page, limit, total };
}

export async function getReceipt(receiptId: Types.ObjectId, tenantIds: Types.ObjectId[]) {
  const receipt = await WalletReceiptModel.findOne({ _id: receiptId, tenantId: { $in: tenantIds } }).lean<ReceiptRecord>();
  if (!receipt) throw ApiError.notFound('Receipt not found');
  return presentReceipt(receipt);
}

/** The receipt of one of this workspace's own top-ups. A pending or rejected top-up has none. */
export async function getReceiptForTopUp(topUpId: Types.ObjectId, tenantId: Types.ObjectId) {
  const receipt = await WalletReceiptModel.findOne({ topUpRequestId: topUpId, tenantId }).lean<ReceiptRecord>();
  if (!receipt) throw ApiError.notFound('There is no receipt for this top-up');
  return presentReceipt(receipt);
}

/** A top-up request as the customer sees it: without who reviewed it internally. */
export function presentTopUp(topUp: TopUpRecord, receiptNumber: string | null = null) {
  return {
    _id: topUp._id,
    id: topUp._id,
    workspaceId: topUp.tenantId,
    amountMinor: topUp.amountMinor,
    currency: topUp.currency,
    paymentMethod: topUp.paymentMethod,
    senderNumber: topUp.senderNumber,
    transactionId: topUp.transactionId,
    note: topUp.note,
    status: topUp.status,
    reviewNote: topUp.reviewNote,
    reviewedAt: topUp.reviewedAt,
    createdAt: topUp.createdAt,
    receipt: topUp.receiptId ? { id: topUp.receiptId, number: receiptNumber } : null,
  };
}

export async function presentTopUps(topUps: TopUpRecord[]) {
  const ids = topUps.map((topUp) => topUp.receiptId).filter((id): id is Types.ObjectId => Boolean(id));
  const receipts = ids.length ? await WalletReceiptModel.find({ _id: { $in: ids } }).select('number').lean() : [];
  const numbers = new Map(receipts.map((receipt) => [String(receipt._id), receipt.number]));
  return topUps.map((topUp) => presentTopUp(topUp, topUp.receiptId ? (numbers.get(String(topUp.receiptId)) ?? null) : null));
}
