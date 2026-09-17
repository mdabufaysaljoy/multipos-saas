import { type SendMoneyPaymentInput, type HostedPaymentInput } from '../wallet/wallet.validators';
import { PAYMENT_PURPOSES } from '../../config/constants';
import { paymentIntentService } from '../../services/payment/paymentIntent.service';
import { paymentRegistry } from '../../services/payment/registry';
import { presentLedgerRows, walletService } from '../../services/wallet/wallet.service';
import { getPlatformSettings } from '../../models/PlatformSettings';
import { TopUpRequestModel } from '../../models/TopUpRequest';
import { type AccountTopUpInput, type AccountTopUpListInput, type AccountWalletTransactionsInput } from '../wallet/wallet.validators';
import { topUpService } from '../wallet/wallet.service';
import { getReceipt, listReceipts, presentTopUps } from '../../services/billing/receipt.service';
import { accountStatement } from '../../services/billing/statement.service';
import type { Request, Response } from 'express';
import { AccountModel, type AccountDoc } from '../../models/Account';
import { TenantModel } from '../../models/Tenant';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, buildPageMeta, paginated, created } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { recordAudit } from '../../services/audit/audit.service';
import { listAccountSubscriptions } from '../../services/subscription/workspaceSubscription.service';
import { accountBillingOverview, accountRenewals, accountDashboard } from './accountBilling.service';
import type { UpdateAccountInput } from './account.validators';
import { getInvoice, listInvoices, listPayments } from '../../services/billing/invoice.service';
import { type AccountInvoiceQuery, type AccountPaymentQuery, type InvoiceParams, type AccountStatementQuery, type AccountReceiptQuery, type ReceiptParams } from '../subscriptions/invoices.validators';

type AccountRecord = AccountDoc & { _id: import('mongoose').Types.ObjectId };

/** The customer-facing shape. Internal markers (trial usage) are not exposed. */
function present(account: AccountRecord, owner: { id: unknown; name: string; email: string }, workspaceCount: number) {
  return {
    id: account._id,
    owner,
    name: account.name,
    contactEmail: account.contactEmail ?? '',
    contactPhone: account.contactPhone ?? '',
    country: account.country ?? 'BD',
    status: account.status,
    workspaceCount,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

const ownerOf = (req: Request) => ({ id: req.auth!.id, name: req.auth!.name, email: req.auth!.email });

export const me = asyncHandler(async (req: Request, res: Response) => {
  const accountId = req.account!.id;
  const [account, workspaceCount] = await Promise.all([
    AccountModel.findById(accountId).lean<AccountRecord>(),
    TenantModel.countDocuments({ accountId }),
  ]);
  if (!account) throw ApiError.notFound('Account not found');
  ok(res, present(account, ownerOf(req), workspaceCount));
});

export const subscriptions = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await listAccountSubscriptions(req.account!.id));
});

export const billing = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await accountBillingOverview(req.account!.id));
});

/**
 * The workspaces whose billing records this owner may read: the account's
 * workspaces now. A named workspace outside them is indistinguishable from a
 * missing one.
 */
async function ownedWorkspaceIds(req: Request, workspaceId?: import('mongoose').Types.ObjectId) {
  const ids = await TenantModel.find({ accountId: req.account!.id }).distinct('_id');
  if (!workspaceId) return ids;
  if (!ids.some((id) => id.equals(workspaceId))) throw ApiError.notFound('Workspace not found');
  return [workspaceId];
}

/**
 * The account wallet as its owner sees it: balance, status, money added,
 * spending by service (Subscription, SMS, Email, other) and how it can be
 * funded. Read through an owned workspace with the owner as the viewer, so the
 * whole account wallet is in scope - and nothing outside it.
 */
export const wallet = asyncHandler(async (req: Request, res: Response) => {
  const owned = await ownedWorkspaceIds(req);
  if (owned.length === 0) throw ApiError.notFound('This account has no workspace yet');
  const range = query<{ from?: Date; to?: Date }>(req);
  const [summary, record, pendingTopUps] = await Promise.all([
    walletService.breakdown(owned[0], range, { userId: req.auth!.id }),
    walletService.getOrCreate(owned[0]),
    TopUpRequestModel.countDocuments({ tenantId: { $in: owned }, status: 'pending' }),
  ]);
  ok(res, {
    ...summary,
    status: record.isFrozen ? 'frozen' : 'active',
    isFrozen: record.isFrozen,
    range: { from: range.from ?? null, to: range.to ?? null },
    pendingTopUps,
    fundingMethods: {
      manual: ['bkash', 'nagad', 'bank'],
      online: paymentRegistry.listAvailable().map((provider) => provider.name),
    },
  });
});

/** Every movement of the account wallet, optionally for one owned workspace. */
export const walletTransactions = asyncHandler(async (req: Request, res: Response) => {
  const input = query<AccountWalletTransactionsInput>(req);
  const owned = await ownedWorkspaceIds(req, input.workspaceId);
  const all = input.workspaceId ? await ownedWorkspaceIds(req) : owned;
  if (all.length === 0) throw ApiError.notFound('This account has no workspace yet');
  const result = await walletService.transactions(all[0], { ...input, workspaceId: input.workspaceId }, { userId: req.auth!.id });
  paginated(res, await presentLedgerRows(result.items as never), buildPageMeta(result.page, result.limit, result.total));
});

/** Every way this account may pay right now. Disabled providers simply are not listed. */
export const paymentMethods = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await paymentIntentService.availableMethods());
});

/** The actor a payment is opened for: the account is the session's, never the request's. */
async function payingActor(req: Request) {
  const owned = await ownedWorkspaceIds(req);
  if (owned.length === 0) throw ApiError.notFound('This account has no workspace yet');
  return { accountId: req.account!.id, tenantId: owned[0], userId: req.auth!.id, userName: req.auth!.name, email: req.auth!.email };
}

/**
 * Declares a Send Money transfer. This credits NOTHING: it records what the
 * customer says they sent, so a reported payment SMS can be matched against it.
 */
export const openSendMoneyPayment = asyncHandler(async (req: Request, res: Response) => {
  const input = body<SendMoneyPaymentInput>(req);
  const actor = await payingActor(req);
  const result = await paymentIntentService.openSendMoney(actor, {
    amountMinor: input.amountMinor,
    purpose: PAYMENT_PURPOSES.WALLET_TOPUP,
    provider: input.provider,
    reference: input.reference,
    customerPhone: input.customerPhone,
    workspaceId: input.workspaceId ?? null,
  });
  await recordAudit(req, {
    action: 'account.payment_opened',
    targetTenantId: input.workspaceId ?? actor.tenantId,
    newValue: { paymentId: String(result.paymentId), provider: input.provider, amountMinor: input.amountMinor, purpose: PAYMENT_PURPOSES.WALLET_TOPUP },
  });
  created(res, result);
});

/** Starts a payment on a provider's hosted page and returns where to send the customer. */
export const openHostedPayment = asyncHandler(async (req: Request, res: Response) => {
  const input = body<HostedPaymentInput>(req);
  const actor = await payingActor(req);
  const result = await paymentIntentService.openHostedCheckout(actor, {
    amountMinor: input.amountMinor,
    purpose: PAYMENT_PURPOSES.WALLET_TOPUP,
    provider: input.provider,
    workspaceId: input.workspaceId ?? null,
  });
  await recordAudit(req, {
    action: 'account.payment_opened',
    targetTenantId: input.workspaceId ?? actor.tenantId,
    newValue: { paymentId: String(result.paymentId), provider: input.provider, amountMinor: input.amountMinor, purpose: PAYMENT_PURPOSES.WALLET_TOPUP },
  });
  created(res, result);
});

export const invoices = asyncHandler(async (req: Request, res: Response) => {
  const input = query<AccountInvoiceQuery>(req);
  const result = await listInvoices(await ownedWorkspaceIds(req, input.workspaceId), input);
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const invoice = asyncHandler(async (req: Request, res: Response) => {
  const { invoiceId } = params<InvoiceParams>(req);
  ok(res, await getInvoice(invoiceId, await ownedWorkspaceIds(req)));
});

export const payments = asyncHandler(async (req: Request, res: Response) => {
  const input = query<AccountPaymentQuery>(req);
  const result = await listPayments(await ownedWorkspaceIds(req, input.workspaceId), input);
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const statement = asyncHandler(async (req: Request, res: Response) => {
  const input = query<AccountStatementQuery>(req);
  const owned = await ownedWorkspaceIds(req);
  if (input.workspaceId && !owned.some((id) => id.equals(input.workspaceId!))) throw ApiError.notFound('Workspace not found');
  ok(res, await accountStatement(owned, input));
});

export const receipts = asyncHandler(async (req: Request, res: Response) => {
  const input = query<AccountReceiptQuery>(req);
  const result = await listReceipts(await ownedWorkspaceIds(req, input.workspaceId), input);
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const receipt = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await getReceipt(params<ReceiptParams>(req).receiptId, await ownedWorkspaceIds(req)));
});

/** Most pending top-up requests an account may have awaiting verification at once. */
const MAX_PENDING_TOP_UPS_PER_ACCOUNT = 5;

/** Writes that move or promise money are refused for a suspended account. */
const assertAccountActive = (req: Request) => {
  if (req.account!.status === 'suspended') throw ApiError.forbidden('This account is suspended. Please contact support.');
};

/** Where to send money, as configured by the platform. */
export const paymentInstructions = asyncHandler(async (_req: Request, res: Response) => {
  const settings = await getPlatformSettings();
  ok(res, {
    instructions: settings.paymentInstructions.filter((instruction) => instruction.isActive),
    supportEmail: settings.supportEmail,
    supportPhone: settings.supportPhone,
  });
});

export const topUps = asyncHandler(async (req: Request, res: Response) => {
  const input = query<AccountTopUpListInput>(req);
  const result = await topUpService.listForWorkspaces(await ownedWorkspaceIds(req, input.workspaceId), input);
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

/**
 * Files a top-up claim for the account wallet. The balance changes only when a
 * platform admin verifies it - the same rule as inside a workspace. The
 * workspace records where it was requested from; the money lands in the one
 * account wallet either way.
 */
export const requestTopUp = asyncHandler(async (req: Request, res: Response) => {
  assertAccountActive(req);
  const { workspaceId, ...input } = body<AccountTopUpInput>(req);
  const workspaces = await TenantModel.find({ accountId: req.account!.id }).sort({ createdAt: 1 }).select('_id name status').lean();
  const target = workspaceId ? workspaces.find((workspace) => workspace._id.equals(workspaceId)) : workspaces[0];
  if (!target) throw ApiError.notFound('Workspace not found');
  if (target.status === 'suspended') throw ApiError.forbidden('This workspace is suspended. Please contact support.');

  const pending = await TopUpRequestModel.countDocuments({ tenantId: { $in: workspaces.map((workspace) => workspace._id) }, status: 'pending' });
  if (pending >= MAX_PENDING_TOP_UPS_PER_ACCOUNT) {
    throw ApiError.conflict('This account already has several top-up requests awaiting verification.', { reason: 'TOO_MANY_PENDING_TOP_UPS' });
  }

  const request = await topUpService.submit({ tenantId: target._id, userId: req.auth!.id, userName: req.auth!.name }, input);
  await recordAudit(req, {
    action: 'wallet.topup_requested',
    targetTenantId: target._id,
    targetUserId: req.auth!.id,
    targetLabel: target.name,
    newValue: { topUpId: String(request._id), amountMinor: request.amountMinor, paymentMethod: request.paymentMethod, source: 'account_billing' },
  });
  created(res, { ...(await presentTopUps([request as never]))[0], workspaceName: target.name });
});

export const cancelTopUp = asyncHandler(async (req: Request, res: Response) => {
  assertAccountActive(req);
  const { topUpId } = params<{ topUpId: import('mongoose').Types.ObjectId }>(req);
  const owned = await ownedWorkspaceIds(req);
  const existing = await TopUpRequestModel.findOne({ _id: topUpId, tenantId: { $in: owned } }).select('tenantId amountMinor').lean();
  if (!existing) throw ApiError.notFound('Request not found');

  const cancelled = await topUpService.cancel({ tenantId: existing.tenantId, userId: req.auth!.id, userName: req.auth!.name }, topUpId);
  await recordAudit(req, {
    action: 'wallet.topup_cancelled',
    targetTenantId: existing.tenantId,
    targetUserId: req.auth!.id,
    targetLabel: String(topUpId),
    newValue: { topUpId: String(topUpId), amountMinor: existing.amountMinor, source: 'account_billing' },
  });
  ok(res, cancelled);
});

export const dashboard = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await accountDashboard(req.account!.id));
});

export const renewals = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await accountRenewals(req.account!.id));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const accountId = req.account!.id;
  const input = body<UpdateAccountInput>(req);

  const before = await AccountModel.findById(accountId).lean<AccountRecord>();
  // Filtered by owner as well as id, so the write can only ever hit the
  // caller's own account even if the id were somehow wrong.
  const account = await AccountModel.findOneAndUpdate(
    { _id: accountId, ownerUserId: req.auth!.id },
    { $set: input },
    { new: true, runValidators: true },
  ).lean<AccountRecord>();
  if (!account || !before) throw ApiError.notFound('Account not found');

  await recordAudit(req, {
    action: 'account.updated',
    targetUserId: req.auth!.id,
    targetLabel: account.name,
    oldValue: Object.fromEntries(Object.keys(input).map((key) => [key, before[key as keyof AccountRecord]])),
    newValue: input,
  });

  ok(res, present(account, ownerOf(req), await TenantModel.countDocuments({ accountId })));
});
