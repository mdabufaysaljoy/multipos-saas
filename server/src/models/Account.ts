import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export type AccountStatus = 'active' | 'suspended';

/**
 * The customer's platform account: the owner of one or more POS workspaces.
 *
 * A workspace is today's `Tenant`. Every business collection stays scoped by
 * `tenantId`; the account sits ABOVE workspaces and owns what they share
 * (billing and wallet in later phases). Nothing reads business data by account.
 *
 * One account per owning user, enforced by a unique index, so a concurrent
 * signup or backfill cannot create two accounts for the same person.
 */
export interface AccountDoc extends BaseDoc {
  ownerUserId: Types.ObjectId;
  /** Customer-level profile: the business owner's display name. */
  name: string;
  contactEmail: string;
  contactPhone: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** A suspended account can no longer act in any of its workspaces except to read its own profile. */
  status: AccountStatus;
  /**
   * When the account's ONE free trial was used. Set atomically when a trial
   * starts on any of its workspaces, so opening more workspaces cannot be used
   * to collect more trials.
   */
  trialUsedAt: Date | null;
}

const accountSchema = new Schema<AccountDoc>(
  {
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    contactEmail: { type: String, lowercase: true, trim: true, default: '' },
    contactPhone: { type: String, trim: true, default: '', maxlength: 40 },
    country: { type: String, uppercase: true, trim: true, default: 'BD', maxlength: 2 },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
    trialUsedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

accountSchema.index({ ownerUserId: 1 }, { unique: true });

export const AccountModel = model<AccountDoc>('Account', accountSchema);
