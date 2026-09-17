import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * A prepaid balance, used for subscriptions, SMS and future platform services.
 *
 * ONE WALLET PER ACCOUNT: every workspace of an account spends from the wallet
 * whose `accountId` is that account. `tenantId` records the workspace the
 * wallet was first opened for; it is history, not ownership.
 *
 * A legacy per-workspace wallet that was merged into its account wallet is
 * kept as an empty, frozen shell (`mergedIntoWalletId`) so its ledger history
 * stays attached to the document it was written against.
 *
 * The balance is a CACHE of the ledger. It is only ever changed through
 * `walletService`, which writes a matching `WalletTransaction` in the same
 * operation - so the balance can always be reconstructed and audited.
 */
export interface WalletDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  /** The owning account. Null only for a workspace not yet linked to an account. */
  accountId: Types.ObjectId | null;
  balanceMinor: number;
  currency: string;
  /** Running totals, useful for the platform dashboard. Transfers never count. */
  lifetimeCreditedMinor: number;
  lifetimeDebitedMinor: number;
  isFrozen: boolean;
  /** `frozen` refuses spending; kept in step with `isFrozen`. */
  status: 'active' | 'frozen';
  /** Recent operation keys, checked in the same atomic update that moves money. */
  appliedOperationKeys: string[];
  /**
   * Counter behind each ledger row's `sequence`. Incremented in the SAME atomic
   * update that moves the balance, so the order rows are listed in is the order
   * the money actually moved - even for movements written in the same millisecond.
   */
  ledgerSequence: number;
  /** Set when this wallet's balance was moved into an account wallet. */
  mergedIntoWalletId: Types.ObjectId | null;
  mergedAt: Date | null;
  /**
   * Balance taken out of this wallet by a merge but not yet delivered. Non-zero
   * only while a merge is in flight, so an interrupted merge never loses money.
   */
  pendingTransferMinor: number;
  pendingTransferId: Types.ObjectId | null;
  /** Transfers already credited INTO this wallet; makes each credit exactly-once. */
  appliedTransferIds: Types.ObjectId[];
}

const walletSchema = new Schema<WalletDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', default: null },
    balanceMinor: {
      type: Number,
      default: 0,
      // A wallet can never go negative; the service also guards every debit.
      min: [0, 'Wallet balance cannot be negative'],
      validate: { validator: Number.isSafeInteger, message: 'balanceMinor must be an integer' },
    },
    currency: { type: String, default: 'BDT', uppercase: true },
    lifetimeCreditedMinor: { type: Number, default: 0 },
    lifetimeDebitedMinor: { type: Number, default: 0 },
    isFrozen: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'frozen'], default: 'active' },
    appliedOperationKeys: { type: [String], default: [], select: false },
    ledgerSequence: { type: Number, default: 0, min: 0 },
    mergedIntoWalletId: { type: Schema.Types.ObjectId, ref: 'Wallet', default: null },
    mergedAt: { type: Date, default: null },
    pendingTransferMinor: { type: Number, default: 0, min: 0 },
    pendingTransferId: { type: Schema.Types.ObjectId, default: null },
    appliedTransferIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true },
);

walletSchema.index({ tenantId: 1 }, { unique: true });
// At most one wallet per account. Partial, so legacy wallets without an account
// (and merged shells, which carry none) do not collide on null.
walletSchema.index(
  { accountId: 1 },
  { unique: true, partialFilterExpression: { accountId: { $type: 'objectId' } } },
);
walletSchema.index(
  { mergedIntoWalletId: 1 },
  { partialFilterExpression: { mergedIntoWalletId: { $type: 'objectId' } } },
);

export const WalletModel = model<WalletDoc>('Wallet', walletSchema);
