import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';
import { ledgerMaintenanceActive } from '../utils/ledgerMaintenance';

/**
 * `transfer_in` / `transfer_out` move an existing balance between two wallets
 * of the same account (a legacy workspace wallet merged into the account
 * wallet). They are neither money added nor money spent, so reports exclude
 * them and they never touch the lifetime totals.
 */
export const WALLET_TX_TYPES = ['credit', 'debit', 'refund', 'adjustment', 'transfer_in', 'transfer_out'] as const;
export type WalletTxType = (typeof WALLET_TX_TYPES)[number];

/** Where money came from or went. New sources are added here, never as free text. */
export const WALLET_SOURCES = [
  'manual_topup',
  'bkash',
  'nagad',
  'bank',
  'admin_adjustment',
  'promotional_credit',
  'subscription',
  'sms',
  'email',
  'ai',
  'storage',
  'addon',
  'refund',
  'transfer',
  'reversal',
  'system',
] as const;
export type WalletSource = (typeof WALLET_SOURCES)[number];

/** Every row is posted when written; a correction is a new, compensating row. */
export const WALLET_TX_STATUSES = ['posted'] as const;

/**
 * Append-only wallet ledger.
 *
 * The balance is never edited on its own - every movement lands here with the
 * balance before and after, so the wallet is fully auditable and a disputed
 * charge can be traced.
 */
export interface WalletTransactionDoc extends BaseDoc {
  /** The workspace whose action caused the movement. */
  tenantId: Types.ObjectId;
  /** The account that paid. Null only for a wallet not yet linked to an account. */
  accountId: Types.ObjectId | null;
  walletId: Types.ObjectId;
  type: WalletTxType;
  /** Always positive; `type` carries the direction. */
  amountMinor: number;
  balanceBeforeMinor: number;
  balanceAfterMinor: number;
  /**
   * Position of this row in its wallet's ledger, assigned with the balance
   * change itself. Rows written before this field existed carry null and fall
   * back to createdAt ordering.
   */
  sequence: number | null;
  currency: string;
  source: WalletSource;
  status: (typeof WALLET_TX_STATUSES)[number];
  /** The description shown on statements. */
  reason: string;
  /** A repeated request with the same key returns this row instead of moving money again. */
  idempotencyKey: string | null;
  /** Set on a compensating row: the row it corrects. */
  reversalOfTransactionId: Types.ObjectId | null;
  referenceType: 'topup' | 'subscription' | 'sms' | 'email' | 'ai' | 'storage' | 'refund' | 'adjustment' | 'transfer' | null;
  referenceId: Types.ObjectId | null;
  performedBy: Types.ObjectId | null;
  performedByNameSnapshot: string;
  metadata: Record<string, unknown>;
}

const walletTxSchema = new Schema<WalletTransactionDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', default: null },
    walletId: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true, index: true },
    type: { type: String, enum: [...WALLET_TX_TYPES], required: true },
    amountMinor: {
      type: Number,
      required: true,
      min: [1, 'A wallet movement must be greater than zero'],
      validate: { validator: Number.isSafeInteger, message: 'amountMinor must be an integer' },
    },
    balanceBeforeMinor: { type: Number, required: true },
    balanceAfterMinor: { type: Number, required: true },
    sequence: { type: Number, default: null },
    currency: { type: String, default: 'BDT', uppercase: true },
    source: { type: String, enum: [...WALLET_SOURCES], default: 'system' },
    status: { type: String, enum: [...WALLET_TX_STATUSES], default: 'posted' },
    reason: { type: String, required: true, maxlength: 300 },
    idempotencyKey: { type: String, default: null, maxlength: 200 },
    reversalOfTransactionId: { type: Schema.Types.ObjectId, ref: 'WalletTransaction', default: null },
    referenceType: {
      type: String,
      enum: ['topup', 'subscription', 'sms', 'email', 'ai', 'storage', 'refund', 'adjustment', 'transfer', null],
      default: null,
    },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    performedByNameSnapshot: { type: String, default: 'system' },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

walletTxSchema.index({ tenantId: 1, createdAt: -1 });
// An account's ledger spans its wallet plus any wallets merged into it.
walletTxSchema.index({ walletId: 1, createdAt: -1 });
// The chain order: how an account's ledger and statement are listed.
walletTxSchema.index({ walletId: 1, sequence: -1 });
walletTxSchema.index({ accountId: 1, createdAt: -1 });
// Each side of a transfer is written exactly once, however often a merge is retried.
walletTxSchema.index(
  { walletId: 1, type: 1, referenceId: 1 },
  { unique: true, partialFilterExpression: { referenceType: 'transfer' } },
);

// A key moves money once per wallet.
walletTxSchema.index({ walletId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
// A row is corrected at most once.
walletTxSchema.index({ reversalOfTransactionId: 1 }, { unique: true, partialFilterExpression: { reversalOfTransactionId: { $type: 'objectId' } } });

// Immutable: history is never edited. Corrections are compensating rows.
const IMMUTABLE_MESSAGE = 'Wallet transactions are immutable. Record a compensating transaction instead.';
walletTxSchema.pre('save', function refuseEdits(next) {
  if (!this.isNew && !ledgerMaintenanceActive()) return next(new Error(IMMUTABLE_MESSAGE));
  next();
});
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  walletTxSchema.pre(operation, function refuseQueryEdits(next: (error?: Error) => void) {
    if (ledgerMaintenanceActive()) return next();
    next(new Error(IMMUTABLE_MESSAGE));
  });
}

export const WalletTransactionModel = model<WalletTransactionDoc>('WalletTransaction', walletTxSchema);
