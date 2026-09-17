import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';
import { DEFAULT_POS_VERTICAL, POS_VERTICALS, type PosVertical } from '../config/verticals';

export type TenantStatus = 'active' | 'suspended';

/** Workspace-wide preferences. Branch operations (receipt, tax, currency) stay on Store. */
export interface WorkspaceSettings {
  timezone: string;
  locale: string;
}

/** What a workspace created before `settings` existed reads as. */
export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = { timezone: 'Asia/Dhaka', locale: 'en-BD' };

/**
 * A tenant is a POS WORKSPACE. Every business collection is scoped by its id.
 * It belongs to one platform account, which may own several workspaces.
 */
export interface TenantDoc extends BaseDoc {
  /**
   * Owning platform account. Set by the server at creation (or by the
   * `migrate:accounts` backfill for older rows); never accepted from a client.
   */
  accountId: Types.ObjectId | null;
  /** Which POS product this workspace runs. Server-decided; not client-writable. */
  vertical: PosVertical;
  name: string;
  slug: string;
  ownerUserId: Types.ObjectId;
  status: TenantStatus;
  /** Denormalised for fast middleware checks; authoritative data lives on Subscription. */
  subscriptionStatus: string;
  currentSubscriptionId: Types.ObjectId | null;
  subscriptionEndsAt: Date | null;
  contactEmail: string;
  contactPhone: string;
  country: string;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  settings: WorkspaceSettings;
  /** Short lease that lets only one subscription purchase run for this workspace at a time. */
  purchaseLockedUntil: Date | null;
}

const tenantSchema = new Schema<TenantDoc>(
  {
    // Not `required` yet: rows created before the account layer have no link
    // until the backfill runs, and saving one must not fail validation.
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', default: null },
    vertical: { type: String, enum: [...POS_VERTICALS], default: DEFAULT_POS_VERTICAL },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
    subscriptionStatus: { type: String, default: 'trial', index: true },
    currentSubscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', default: null },
    subscriptionEndsAt: { type: Date, default: null },
    contactEmail: { type: String, lowercase: true, trim: true, default: '' },
    contactPhone: { type: String, trim: true, default: '' },
    country: { type: String, default: 'BD' },
    suspendedAt: { type: Date, default: null },
    suspendedReason: { type: String, default: null },
    settings: {
      timezone: { type: String, trim: true, default: DEFAULT_WORKSPACE_SETTINGS.timezone, maxlength: 64 },
      locale: { type: String, trim: true, default: DEFAULT_WORKSPACE_SETTINGS.locale, maxlength: 16 },
    },
    purchaseLockedUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

tenantSchema.index({ slug: 1 }, { unique: true });
// "All workspaces of this account", optionally narrowed to one vertical.
tenantSchema.index({ accountId: 1, vertical: 1 });

export const TenantModel = model<TenantDoc>('Tenant', tenantSchema);
