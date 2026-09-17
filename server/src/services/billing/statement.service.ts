import { Types } from 'mongoose';
import { InvoiceModel } from '../../models/Invoice';
import { PaymentModel } from '../../models/Payment';
import { TenantModel } from '../../models/Tenant';
import { UsageChargeModel } from '../../models/UsageCharge';
import { WalletModel } from '../../models/Wallet';
import { WalletReceiptModel } from '../../models/WalletReceipt';
import { WalletTransactionModel, type WalletTransactionDoc } from '../../models/WalletTransaction';
import { walletService } from '../wallet/wallet.service';

type LedgerRow = WalletTransactionDoc & { _id: Types.ObjectId };

const DAY_MS = 86_400_000;
/** A statement lists at most this many movements; a longer period is flagged as truncated. */
export const STATEMENT_MAX_ENTRIES = 2000;

export type StatementCategory = 'topup' | 'subscription' | 'sms' | 'email' | 'ai' | 'storage' | 'adjustment' | 'refund' | 'other';

/** The movement's effect on the balance. Adjustments carry their direction in the balances. */
export const signedAmount = (row: Pick<LedgerRow, 'type' | 'amountMinor' | 'balanceBeforeMinor' | 'balanceAfterMinor'>) => {
  switch (row.type) {
    case 'credit':
    case 'refund':
    case 'transfer_in':
      return row.amountMinor;
    case 'debit':
    case 'transfer_out':
      return -row.amountMinor;
    case 'adjustment':
      return row.balanceAfterMinor >= row.balanceBeforeMinor ? row.amountMinor : -row.amountMinor;
    default:
      return 0;
  }
};

const CATEGORIES: StatementCategory[] = ['topup', 'subscription', 'sms', 'email', 'ai', 'storage', 'adjustment', 'refund'];
const categoryOf = (row: LedgerRow): StatementCategory => {
  const reference = row.referenceType ?? '';
  return (CATEGORIES as string[]).includes(reference) ? (reference as StatementCategory) : 'other';
};

/** The sum of every wallet's last recorded balance strictly before a moment. */
async function balanceBefore(walletIds: Types.ObjectId[], moment: Date) {
  const rows = await WalletTransactionModel.aggregate<{ balanceAfterMinor: number }>([
    { $match: { walletId: { $in: walletIds }, createdAt: { $lt: moment } } },
    { $sort: { createdAt: -1, sequence: -1, _id: -1 } },
    { $group: { _id: '$walletId', balanceAfterMinor: { $first: '$balanceAfterMinor' } } },
  ]);
  return rows.reduce((sum, row) => sum + row.balanceAfterMinor, 0);
}

export interface StatementInput {
  from?: Date;
  to?: Date;
  workspaceId?: Types.ObjectId;
}

/**
 * The account statement: every movement of the account wallet over a period,
 * built from the append-only ledger - never from cached totals.
 *
 *   opening balance + money in - money out = closing balance
 *
 * Opening and closing balances are read from the ledger's own recorded
 * balances (summed over the account wallet and any legacy wallets merged into
 * it), and the running balance is recomputed row by row; `reconciled` says
 * whether the two agree. Moves between the account's own wallets are not
 * money in or out, so they are left off the list but still counted.
 *
 * With a workspace filter, only that workspace's movements are listed; the
 * balances stay account-wide (the wallet is shared), so rows carry no running
 * balance. Subscription payments made outside the wallet (bKash, bank) are
 * listed separately: they never touched the balance.
 *
 * `ownedWorkspaceIds` is the account's workspaces, resolved by the caller from
 * the session - nothing here trusts an id from the request.
 */
export async function accountStatement(ownedWorkspaceIds: Types.ObjectId[], input: StatementInput, now = new Date()) {
  const from = input.from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // Up to and including this moment: a movement written in the same millisecond belongs on the statement.
  const toExclusive = input.to ? new Date(input.to.getTime() + DAY_MS) : new Date(now.getTime() + 1);
  const filtered = input.workspaceId ?? null;

  const empty = {
    period: { from, to: new Date(toExclusive.getTime() - 1) },
    currency: 'BDT',
    workspaceId: filtered,
    openingBalanceMinor: 0,
    closingBalanceMinor: 0,
    moneyInMinor: 0,
    moneyOutMinor: 0,
    categories: [] as { category: StatementCategory; inMinor: number; outMinor: number }[],
    entries: [] as ReturnType<typeof buildEntry>[],
    truncated: false,
    reconciled: true as boolean | null,
    paidOutsideWallet: [] as { id: Types.ObjectId; number: string; issuedAt: Date; workspace: { id: Types.ObjectId; name: string }; amountMinor: number; currency: string; method: string }[],
  };
  if (ownedWorkspaceIds.length === 0) return empty;

  // One wallet per account: any owned workspace resolves to it.
  const wallet = await walletService.getOrCreate(ownedWorkspaceIds[0]);
  const merged = await WalletModel.find({ mergedIntoWalletId: wallet._id }).select('_id').lean();
  const walletIds = [wallet._id, ...merged.map((row) => row._id)];

  const [openingBalanceMinor, closingBalanceMinor, fetched] = await Promise.all([
    balanceBefore(walletIds, from),
    balanceBefore(walletIds, toExclusive),
    WalletTransactionModel.find({ walletId: { $in: walletIds }, createdAt: { $gte: from, $lt: toExclusive } })
      .sort({ createdAt: 1, sequence: 1, _id: 1 })
      .limit(STATEMENT_MAX_ENTRIES + 1)
      .lean<LedgerRow[]>(),
  ]);
  const truncated = fetched.length > STATEMENT_MAX_ENTRIES;
  const rows = truncated ? fetched.slice(0, STATEMENT_MAX_ENTRIES) : fetched;

  // Names and references, looked up in bulk and only within the account's own workspaces.
  const rowTenantIds = [...new Set(rows.map((row) => String(row.tenantId)))].map((id) => new Types.ObjectId(id));
  const scopeIds = [...new Set([...ownedWorkspaceIds.map(String), ...rowTenantIds.map(String)])].map((id) => new Types.ObjectId(id));
  const topUpIds = rows.filter((row) => row.referenceType === 'topup' && row.referenceId).map((row) => row.referenceId!);
  const walletRefs = rows.filter((row) => row.referenceType === 'subscription' && row.type === 'debit').map((row) => `WALLET-${row._id}`);
  const debitIds = rows.filter((row) => row.type === 'debit').map((row) => row._id);

  const [workspaces, receipts, walletPayments, usage, external] = await Promise.all([
    TenantModel.find({ _id: { $in: scopeIds } }).select('name').lean(),
    topUpIds.length ? WalletReceiptModel.find({ topUpRequestId: { $in: topUpIds }, tenantId: { $in: scopeIds } }).select('number topUpRequestId').lean() : [],
    walletRefs.length ? PaymentModel.find({ tenantId: { $in: scopeIds }, providerReference: { $in: walletRefs } }).select('providerReference invoiceId').lean() : [],
    debitIds.length ? UsageChargeModel.find({ tenantId: { $in: scopeIds }, debitTransactionId: { $in: debitIds } }).select('debitTransactionId service quantity unit').lean() : [],
    InvoiceModel.find({ tenantId: { $in: filtered ? [filtered] : ownedWorkspaceIds }, issuedAt: { $gte: from, $lt: toExclusive }, 'payment.method': { $ne: 'wallet' } })
      .sort({ issuedAt: 1 })
      .limit(500)
      .select('number issuedAt tenantId totalMinor currency payment billedTo')
      .lean(),
  ]);
  const invoiceIds = walletPayments.map((payment) => payment.invoiceId).filter((id): id is Types.ObjectId => Boolean(id));
  const invoices = invoiceIds.length ? await InvoiceModel.find({ _id: { $in: invoiceIds } }).select('number').lean() : [];

  const names = new Map(workspaces.map((workspace) => [String(workspace._id), workspace.name]));
  const receiptByTopUp = new Map(receipts.map((receipt) => [String(receipt.topUpRequestId), receipt]));
  const invoiceNumbers = new Map(invoices.map((invoice) => [String(invoice._id), invoice.number]));
  const invoiceByRef = new Map(walletPayments.map((payment) => [payment.providerReference ?? '', payment.invoiceId ? { id: payment.invoiceId, number: invoiceNumbers.get(String(payment.invoiceId)) ?? null } : null]));
  const usageByDebit = new Map(usage.map((charge) => [String(charge.debitTransactionId), charge]));

  function buildEntry(row: LedgerRow, balanceAfterMinor: number | null) {
    const signed = signedAmount(row);
    let reference: { kind: 'receipt' | 'invoice' | 'usage'; id: Types.ObjectId | null; label: string } | null = null;
    const receipt = row.referenceId ? receiptByTopUp.get(String(row.referenceId)) : undefined;
    const invoice = invoiceByRef.get(`WALLET-${row._id}`);
    const charge = usageByDebit.get(String(row._id));
    if (receipt) reference = { kind: 'receipt', id: receipt._id, label: receipt.number };
    else if (invoice?.number) reference = { kind: 'invoice', id: invoice.id, label: invoice.number };
    else if (charge) reference = { kind: 'usage', id: null, label: `${charge.quantity} ${charge.unit}` };
    return {
      id: row._id,
      at: row.createdAt,
      workspace: { id: row.tenantId, name: names.get(String(row.tenantId)) ?? '' },
      category: categoryOf(row),
      direction: signed >= 0 ? ('in' as const) : ('out' as const),
      amountMinor: row.amountMinor,
      balanceAfterMinor,
      description: row.reason,
      reference,
    };
  }

  let running = openingBalanceMinor;
  let moneyInMinor = 0;
  let moneyOutMinor = 0;
  const byCategory = new Map<StatementCategory, { inMinor: number; outMinor: number }>();
  const entries: ReturnType<typeof buildEntry>[] = [];
  for (const row of rows) {
    const signed = signedAmount(row);
    running += signed;
    if (row.type === 'transfer_in' || row.type === 'transfer_out') continue;
    if (filtered && !row.tenantId.equals(filtered)) continue;

    entries.push(buildEntry(row, filtered ? null : running));
    const bucket = byCategory.get(categoryOf(row)) ?? { inMinor: 0, outMinor: 0 };
    if (signed >= 0) {
      moneyInMinor += signed;
      bucket.inMinor += signed;
    } else {
      moneyOutMinor += -signed;
      bucket.outMinor += -signed;
    }
    byCategory.set(categoryOf(row), bucket);
  }

  return {
    ...empty,
    currency: wallet.currency,
    openingBalanceMinor,
    closingBalanceMinor,
    moneyInMinor,
    moneyOutMinor,
    categories: [...byCategory.entries()].map(([category, totals]) => ({ category, ...totals })),
    entries,
    truncated,
    // Whether the ledger's own balances agree with the movements between them. Unknown when truncated.
    reconciled: truncated ? null : running === closingBalanceMinor,
    paidOutsideWallet: external.map((invoice) => ({
      id: invoice._id,
      number: invoice.number,
      issuedAt: invoice.issuedAt,
      workspace: { id: invoice.tenantId, name: invoice.billedTo?.workspaceName ?? names.get(String(invoice.tenantId)) ?? '' },
      amountMinor: invoice.totalMinor,
      currency: invoice.currency,
      method: invoice.payment.method,
    })),
  };
}
