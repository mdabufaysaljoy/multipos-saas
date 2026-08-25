import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export type TenantStatus = 'active' | 'suspended';

export interface TenantDoc extends BaseDoc {
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
}

const tenantSchema = new Schema<TenantDoc>(
  {
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
  },
  { timestamps: true },
);

tenantSchema.index({ slug: 1 }, { unique: true });

export const TenantModel = model<TenantDoc>('Tenant', tenantSchema);
