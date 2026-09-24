import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * A tender a workspace takes that is not one of the six built-ins.
 *
 * The built-ins (cash, bKash, Nagad, bank, card, other) are NOT stored here:
 * they exist for every workspace, always, and nothing needs to be created or
 * migrated for them. This collection holds only what a shop added itself - a
 * local wallet, a corporate account, a meal voucher.
 *
 * A method is never deleted while history refers to it; it is deactivated,
 * which takes it off the till and leaves every sale that used it readable.
 */
export interface PaymentMethodDoc extends BaseDoc {
  tenantId: Types.ObjectId;
  /** Stored on every payment line. Lowercase, stable, never reused. */
  key: string;
  /** What the till and the receipt show. Renaming it does not rewrite history. */
  label: string;
  isActive: boolean;
  sortOrder: number;
  createdBy: Types.ObjectId | null;
}

const paymentMethodSchema = new Schema<PaymentMethodDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    key: { type: String, required: true, trim: true, lowercase: true, maxlength: 24 },
    label: { type: String, required: true, trim: true, maxlength: 40 },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// One key per workspace, so a payment line's `method` always resolves to one thing.
paymentMethodSchema.index({ tenantId: 1, key: 1 }, { unique: true });

export const PaymentMethodModel = model<PaymentMethodDoc>('PaymentMethod', paymentMethodSchema);
