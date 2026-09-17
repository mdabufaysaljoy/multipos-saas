import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * A receipt for money added to the account wallet by an approved top-up.
 *
 * IMMUTABLE, like an invoice: everything on it is a snapshot from the moment
 * the top-up was approved - who issued it, who paid, how, and the wallet
 * balance straight after. The full sending number is never stored here, only
 * its last four digits.
 */
export interface WalletReceiptDoc extends BaseDoc {
  number: string;
  year: number;
  sequence: number;
  accountId: Types.ObjectId | null;
  tenantId: Types.ObjectId;
  topUpRequestId: Types.ObjectId;
  walletTransactionId: Types.ObjectId;
  issuedAt: Date;
  amountMinor: number;
  currency: string;
  issuer: { name: string; address: string; email: string; phone: string };
  receivedFrom: { accountName: string; workspaceName: string; email: string; phone: string };
  payment: { method: string; transactionId: string; senderLast4: string };
  /** The account wallet balance straight after the top-up was credited. */
  balanceAfterMinor: number | null;
}

const integer = { validator: Number.isSafeInteger, message: 'Amounts must be integers in minor units' };

const walletReceiptSchema = new Schema<WalletReceiptDoc>(
  {
    number: { type: String, required: true },
    year: { type: Number, required: true },
    sequence: { type: Number, required: true, min: 1 },
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', default: null },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    topUpRequestId: { type: Schema.Types.ObjectId, ref: 'TopUpRequest', required: true },
    walletTransactionId: { type: Schema.Types.ObjectId, ref: 'WalletTransaction', required: true },
    issuedAt: { type: Date, required: true },
    amountMinor: { type: Number, required: true, min: 1, validate: integer },
    currency: { type: String, required: true, uppercase: true },
    issuer: {
      name: { type: String, default: '' },
      address: { type: String, default: '' },
      email: { type: String, default: '' },
      phone: { type: String, default: '' },
    },
    receivedFrom: {
      accountName: { type: String, default: '' },
      workspaceName: { type: String, default: '' },
      email: { type: String, default: '' },
      phone: { type: String, default: '' },
    },
    payment: {
      method: { type: String, required: true },
      transactionId: { type: String, default: '' },
      senderLast4: { type: String, default: '', maxlength: 4 },
    },
    balanceAfterMinor: { type: Number, default: null },
  },
  { timestamps: true },
);

const IMMUTABLE_MESSAGE = 'Receipts are immutable.';
walletReceiptSchema.pre('save', function refuseEdits(next) {
  if (!this.isNew) return next(new Error(IMMUTABLE_MESSAGE));
  next();
});
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  walletReceiptSchema.pre(operation, function refuseQueryEdits(next: (error?: Error) => void) {
    next(new Error(IMMUTABLE_MESSAGE));
  });
}

walletReceiptSchema.index({ number: 1 }, { unique: true });
// One receipt per top-up, however often issuing is attempted.
walletReceiptSchema.index({ topUpRequestId: 1 }, { unique: true });
walletReceiptSchema.index({ tenantId: 1, issuedAt: -1 });
walletReceiptSchema.index({ accountId: 1, issuedAt: -1 });

export const WalletReceiptModel = model<WalletReceiptDoc>('WalletReceipt', walletReceiptSchema);
