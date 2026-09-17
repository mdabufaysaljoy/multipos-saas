import { type WalletAdjustmentInput } from './accountsSupport.validators';
import { WalletTransactionModel } from '../../models/WalletTransaction';
import { logger } from '../../utils/logger';
import { walletService } from '../../services/wallet/wallet.service';
import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { AccountModel } from '../../models/Account';
import { AuditLogModel } from '../../models/AuditLog';
import { TenantModel } from '../../models/Tenant';
import { TopUpRequestModel } from '../../models/TopUpRequest';
import { UserModel } from '../../models/User';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, ok, paginated } from '../../utils/apiResponse';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { params, query, body } from '../../middleware/validate';
import { accountBillingOverview } from '../account/accountBilling.service';
import { getInvoice, listInvoices, listPayments } from '../../services/billing/invoice.service';
import { getReceipt, listReceipts } from '../../services/billing/receipt.service';
import { accountStatement } from '../../services/billing/statement.service';
import { topUpService } from '../wallet/wallet.service';

/**
 * Platform support view of one customer account - its workspaces, billing,
 * wallet statement, invoices, receipts, payments and top-ups - built on exactly
 * the services the owner's own Billing page uses, so support sees what the
 * customer sees. Reads change nothing.
 *
 * The only writes here are wallet adjustments and compensating reversals (at
 * the end of this file): each needs a reason, is idempotent, and is audited
 * before the money moves.
 *
 * Every read of an account's details requires a reason and is recorded in the
 * audit log BEFORE anything is returned. If that record cannot be written, the
 * data is not returned: access to customer money is never unaudited.
 */

const ACCESS_ACTION = 'platform.account_viewed';

type AccessInput = { reason: string; workspaceId?: Types.ObjectId };

async function openAccount(req: Request, section: string, extra: Record<string, unknown> = {}) {
  const { accountId } = params<{ accountId: Types.ObjectId }>(req);
  const input = query<AccessInput>(req);
  const account = await AccountModel.findById(accountId).lean();
  if (!account) throw ApiError.notFound('Account not found');

  const workspaces = await TenantModel.find({ accountId }).sort({ createdAt: 1 }).select('_id name vertical status').lean();
  const workspaceIds = workspaces.map((workspace) => workspace._id);
  if (input.workspaceId && !workspaceIds.some((id) => id.equals(input.workspaceId!))) throw ApiError.notFound('Workspace not found');

  // Fail closed: written with `create`, not the best-effort `recordAudit`.
  await AuditLogModel.create({
    actorId: req.auth?.id ?? null,
    actorNameSnapshot: req.auth?.name ?? 'unknown',
    actorRole: req.auth?.role ?? '',
    action: ACCESS_ACTION,
    targetTenantId: input.workspaceId ?? workspaceIds[0] ?? null,
    targetUserId: account.ownerUserId,
    targetLabel: account.name,
    newValue: { accountId: String(accountId), section, reason: input.reason, ...(input.workspaceId ? { workspaceId: String(input.workspaceId) } : {}), ...extra },
    ip: req.ip ?? '',
  });

  return { account, workspaces, workspaceIds, scope: input.workspaceId ? [input.workspaceId] : workspaceIds };
}

/** Accounts directory: who they are and how many workspaces. No financial detail without opening one. */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const input = query<{ page?: number; limit?: number; search?: string; status?: string }>(req);
  const { page, limit, skip } = resolvePage(input);
  const filter: Record<string, unknown> = {};
  if (input.status) filter.status = input.status;
  if (input.search) {
    const rx = searchRegex(input.search);
    const owners = await UserModel.find({ email: rx, deletedAt: null }).select('_id').limit(200).lean();
    filter.$or = [{ name: rx }, { contactEmail: rx }, { contactPhone: rx }, { ownerUserId: { $in: owners.map((owner) => owner._id) } }];
  }

  const [accounts, total] = await Promise.all([
    AccountModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select('name contactEmail status ownerUserId createdAt').lean(),
    AccountModel.countDocuments(filter),
  ]);
  const [owners, counts] = await Promise.all([
    UserModel.find({ _id: { $in: accounts.map((account) => account.ownerUserId) } }).select('name email').lean(),
    TenantModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { accountId: { $in: accounts.map((account) => account._id) } } },
      { $group: { _id: '$accountId', count: { $sum: 1 } } },
    ]),
  ]);
  const ownerById = new Map(owners.map((owner) => [String(owner._id), owner]));
  const countById = new Map(counts.map((row) => [String(row._id), row.count]));

  paginated(
    res,
    accounts.map((account) => {
      const owner = ownerById.get(String(account.ownerUserId));
      return {
        id: account._id,
        name: account.name,
        contactEmail: account.contactEmail ?? '',
        status: account.status,
        owner: owner ? { id: owner._id, name: owner.name, email: owner.email } : null,
        workspaceCount: countById.get(String(account._id)) ?? 0,
        createdAt: account.createdAt,
      };
    }),
    buildPageMeta(page, limit, total),
  );
});

/** The support overview: profile, owner, every workspace's billing, the wallet, and recent support access. */
export const overview = asyncHandler(async (req: Request, res: Response) => {
  const { account, workspaceIds } = await openAccount(req, 'overview');
  const [owner, billing, pendingTopUps, history] = await Promise.all([
    UserModel.findById(account.ownerUserId).select('name email phone isActive').lean(),
    accountBillingOverview(account._id),
    TopUpRequestModel.countDocuments({ tenantId: { $in: workspaceIds }, status: 'pending' }),
    AuditLogModel.find({ action: ACCESS_ACTION, 'newValue.accountId': String(account._id) })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('actorNameSnapshot createdAt newValue')
      .lean(),
  ]);

  ok(res, {
    account: {
      id: account._id,
      name: account.name,
      contactEmail: account.contactEmail ?? '',
      contactPhone: account.contactPhone ?? '',
      country: account.country ?? '',
      status: account.status,
      trialUsed: Boolean(account.trialUsedAt),
      createdAt: account.createdAt,
    },
    owner: owner ? { id: owner._id, name: owner.name, email: owner.email, phone: owner.phone ?? '', isActive: owner.isActive } : null,
    billing,
    pendingTopUps,
    supportHistory: history.map((entry) => {
      const value = (entry.newValue ?? {}) as { section?: string; reason?: string };
      return { id: entry._id, actorName: entry.actorNameSnapshot, at: entry.createdAt, section: value.section ?? null, reason: value.reason ?? null };
    }),
  });
});

export const statement = asyncHandler(async (req: Request, res: Response) => {
  const input = query<AccessInput & { from?: Date; to?: Date }>(req);
  const { workspaceIds } = await openAccount(req, 'statement', { from: input.from ?? null, to: input.to ?? null });
  ok(res, await accountStatement(workspaceIds, { from: input.from, to: input.to, workspaceId: input.workspaceId }));
});

export const invoices = asyncHandler(async (req: Request, res: Response) => {
  const { scope } = await openAccount(req, 'invoices');
  const result = await listInvoices(scope, query(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const invoice = asyncHandler(async (req: Request, res: Response) => {
  const { documentId } = params<{ documentId: Types.ObjectId }>(req);
  const { workspaceIds } = await openAccount(req, 'invoice', { documentId: String(documentId) });
  ok(res, await getInvoice(documentId, workspaceIds));
});

export const receipts = asyncHandler(async (req: Request, res: Response) => {
  const { scope } = await openAccount(req, 'receipts');
  const result = await listReceipts(scope, query(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const receipt = asyncHandler(async (req: Request, res: Response) => {
  const { documentId } = params<{ documentId: Types.ObjectId }>(req);
  const { workspaceIds } = await openAccount(req, 'receipt', { documentId: String(documentId) });
  ok(res, await getReceipt(documentId, workspaceIds));
});

export const payments = asyncHandler(async (req: Request, res: Response) => {
  const { scope } = await openAccount(req, 'payments');
  const result = await listPayments(scope, query(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const topUps = asyncHandler(async (req: Request, res: Response) => {
  const { scope } = await openAccount(req, 'top_ups');
  const result = await topUpService.listForWorkspaces(scope, query(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

// ------------------------------------------------------------------ wallet

/** The ledger row as platform staff see it: who did it and with which key, but no provider metadata. */
const internalLedgerRow = (row: Record<string, unknown> & { _id: Types.ObjectId }) => ({
  id: row._id,
  tenantId: row.tenantId,
  walletId: row.walletId,
  type: row.type,
  amountMinor: row.amountMinor,
  currency: row.currency ?? 'BDT',
  balanceBeforeMinor: row.balanceBeforeMinor,
  balanceAfterMinor: row.balanceAfterMinor,
  source: row.source ?? 'system',
  status: row.status ?? 'posted',
  description: row.reason,
  referenceType: row.referenceType ?? null,
  referenceId: row.referenceId ?? null,
  idempotencyKey: row.idempotencyKey ?? null,
  reversalOfTransactionId: row.reversalOfTransactionId ?? null,
  performedBy: row.performedBy ?? null,
  performedByName: row.performedByNameSnapshot,
  createdAt: row.createdAt,
});

async function accountWallet(accountId: Types.ObjectId) {
  const account = await AccountModel.findById(accountId).lean();
  if (!account) throw ApiError.notFound('Account not found');
  const workspaces = await TenantModel.find({ accountId }).sort({ createdAt: 1 }).select('_id name').lean();
  if (workspaces.length === 0) throw ApiError.conflict('This account has no workspace, so it has no wallet yet');
  const wallet = await walletService.getOrCreate(workspaces[0]._id);
  return { account, workspaces, wallet, walletIds: await walletService.familyIds(wallet._id) };
}

/** Audit that must exist before money moves: if it cannot be written, nothing happens. */
const auditIntent = (req: Request, action: string, account: { _id: Types.ObjectId; name: string; ownerUserId: Types.ObjectId }, tenantId: Types.ObjectId, value: Record<string, unknown>) =>
  AuditLogModel.create({
    actorId: req.auth?.id ?? null,
    actorNameSnapshot: req.auth?.name ?? 'unknown',
    actorRole: req.auth?.role ?? '',
    action,
    targetTenantId: tenantId,
    targetUserId: account.ownerUserId,
    targetLabel: account.name,
    newValue: { accountId: String(account._id), ...value },
    ip: req.ip ?? '',
  });

/** The outcome, recorded after the fact. A failure here is loud; the intent and the ledger row still stand. */
const auditOutcome = async (...args: Parameters<typeof auditIntent>) => {
  try {
    await auditIntent(...args);
  } catch (error) {
    logger.error('Recording the outcome of a wallet adjustment failed', { action: args[1], error: error instanceof Error ? error.message : 'unknown' });
  }
};

/** The account wallet and its full ledger, read with a reason. */
export const wallet = asyncHandler(async (req: Request, res: Response) => {
  const input = query<{ page?: number; limit?: number; type?: string; workspaceId?: Types.ObjectId }>(req);
  const { workspaceIds } = await openAccount(req, 'wallet');
  if (workspaceIds.length === 0) return ok(res, { wallet: null, transactions: [], page: 1, limit: input.limit ?? 20, total: 0 });

  const current = await walletService.getOrCreate(workspaceIds[0]);
  const family = await walletService.familyIds(current._id);
  const { page, limit, skip } = resolvePage(input);
  const filter: Record<string, unknown> = { walletId: { $in: family } };
  if (input.workspaceId) filter.tenantId = input.workspaceId;
  if (input.type) filter.type = input.type;
  const [rows, total, balance] = await Promise.all([
    WalletTransactionModel.find(filter).sort({ createdAt: -1, sequence: -1, _id: -1 }).skip(skip).limit(limit).select('-metadata').lean(),
    WalletTransactionModel.countDocuments(filter),
    walletService.balance(workspaceIds[0]),
  ]);
  ok(res, {
    wallet: { id: current._id, balanceMinor: balance.balanceMinor, currency: balance.currency, status: balance.status, lifetimeCreditedMinor: balance.lifetimeCreditedMinor, lifetimeDebitedMinor: balance.lifetimeDebitedMinor },
    transactions: rows.map((row) => internalLedgerRow(row as never)),
    page,
    limit,
    total,
  });
});

/**
 * A manual balance adjustment by a platform admin: authorised by role, with a
 * mandatory reason, an idempotency key, and an audit entry written BEFORE the
 * money moves (plus one for the outcome).
 */
export const adjustWallet = asyncHandler(async (req: Request, res: Response) => {
  const input = body<WalletAdjustmentInput>(req);
  const { accountId } = params<{ accountId: Types.ObjectId }>(req);
  const { account, workspaces } = await accountWallet(accountId);
  const target = workspaces[0]._id;
  const detail = { direction: input.direction, amountMinor: input.amountMinor, reason: input.reason, source: input.source, idempotencyKey: input.idempotencyKey };

  await auditIntent(req, 'platform.wallet_adjustment_requested', account, target, detail);
  const movement = {
    amountMinor: input.amountMinor,
    reason: input.reason,
    referenceType: 'adjustment' as const,
    performedBy: req.auth!.id,
    performedByName: req.auth!.name,
    source: input.source,
    idempotencyKey: `platform-adjust:${String(accountId)}:${input.idempotencyKey}`,
  };
  let result;
  try {
    result = input.direction === 'credit' ? await walletService.credit(target, movement, 'adjustment') : await walletService.debit(target, movement);
  } catch (error) {
    await auditOutcome(req, 'platform.wallet_adjustment_failed', account, target, { ...detail, error: error instanceof Error ? error.message : 'unknown' });
    throw error;
  }
  await auditOutcome(req, result.replayed ? 'platform.wallet_adjustment_replayed' : 'platform.wallet_adjusted', account, target, {
    ...detail,
    transactionId: String(result.transaction._id),
    balanceAfterMinor: result.balanceMinor,
  });
  ok(res, { transaction: internalLedgerRow(result.transaction as never), balanceMinor: result.balanceMinor, replayed: result.replayed });
});

/** Corrects a posted transaction with a compensating one. The original row is never touched. */
export const reverseTransaction = asyncHandler(async (req: Request, res: Response) => {
  const { accountId, transactionId } = params<{ accountId: Types.ObjectId; transactionId: Types.ObjectId }>(req);
  const { reason } = body<{ reason: string }>(req);
  const { account, workspaces, walletIds } = await accountWallet(accountId);
  if (!(await WalletTransactionModel.exists({ _id: transactionId, walletId: { $in: walletIds } }))) throw ApiError.notFound('Transaction not found');

  const target = workspaces[0]._id;
  await auditIntent(req, 'platform.wallet_reversal_requested', account, target, { transactionId: String(transactionId), reason });
  let result;
  try {
    result = await walletService.reverse(transactionId, { reason, performedBy: req.auth!.id, performedByName: req.auth!.name }, walletIds);
  } catch (error) {
    await auditOutcome(req, 'platform.wallet_reversal_failed', account, target, { transactionId: String(transactionId), reason, error: error instanceof Error ? error.message : 'unknown' });
    throw error;
  }
  await auditOutcome(req, 'platform.wallet_reversed', account, target, {
    transactionId: String(transactionId),
    reversalTransactionId: String(result.transaction._id),
    reason,
    balanceAfterMinor: result.balanceMinor,
  });
  ok(res, { transaction: internalLedgerRow(result.transaction as never), balanceMinor: result.balanceMinor, replayed: result.replayed });
});
